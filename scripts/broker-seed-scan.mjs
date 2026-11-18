// Scans the last 30 days of Claude transcripts for the API calls Joe's chats actually make to
// the six brokered services and writes the broker policy seed (rows only).
//
//   node scripts/broker-seed-scan.mjs [--days 30] [--projects <dir>]... [--out <file>] [--summary-only]
//
// Default input: every `projects` folder under ~/.claude and ~/.claude-personal. Default output:
// src-tauri/src/daemon/broker/broker-policy-seed.json (the file the Rust policy embeds).
//
// What it reads: only tool_use inputs (commands and file contents a chat WROTE), never tool
// results, so a response body that echoed a secret is never looked at. What it writes: method plus
// a path SHAPE per service (ids become `\d+`, uuids and 24-hex ids become classes, anything that
// is not a plain lowercase word becomes `[^/]+`), never a value or a private identifier. Every
// string printed or written goes through `redact`, which replaces anything token-shaped.
//
// Rows only for writes (POST, PUT, PATCH). GET is open in the policy, DELETE and bulk endpoints
// are never seeded, and Linear is seeded only for the three pinned operations.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOSTS = {
  "api.app.shortcut.com": { service: "shortcut", prefix: "/api/v3/" },
  "api.linear.app": { service: "linear", prefix: "/graphql" },
  "api.trello.com": { service: "trello", prefix: "/1/" },
  "api.figma.com": { service: "figma", prefix: "/v1/" },
  "api.clockify.me": { service: "clockify", prefix: "/api/v1/" },
  "api.hubstaff.com": { service: "hubstaff", prefix: "/v2/" },
};

/** The only Linear writes the policy can ever hold; mirrors `LINEAR_OPS` in policy_file.rs. */
export const LINEAR_OPS = { commentCreate: true, issueCreate: false, issueUpdate: true };

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Replaces anything shaped like a credential: a long run of token characters that mixes letters and digits. */
export function redact(text) {
  return String(text).replace(/[A-Za-z0-9_\-+=]{24,}/g, (m) => (/[A-Za-z]/.test(m) && /[0-9]/.test(m) ? "[REDACTED]" : m));
}

const SEG_DIGITS = /^\d+$/;
const SEG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEG_HEX24 = /^[0-9a-f]{24}$/i;
const SEG_WORD = /^[a-z][a-z_-]{0,23}$/;

/**
 * `/api/v3/stories/123/comments?x=1` -> `^/api/v3/stories/\d+/comments$`. The service's own
 * prefix (`/api/v3/`) stays literal; only what follows it is shaped.
 */
export function pathShape(rawPath, prefix = "/", service = "") {
  const p = rawPath.split(/[?#]/)[0];
  const rest = p.startsWith(prefix) ? p.slice(prefix.length) : p;
  const lead = p.startsWith(prefix) ? prefix : "/";
  // A shell or template variable stands where an id goes (`$id`, `${e}`, `<id>`); give it the
  // id class its service uses, so a placeholder never widens a row to "any segment".
  const idClass = service === "shortcut" ? "\\d+" : service === "clockify" || service === "trello" ? "[0-9a-f]{24}" : "[^/]+";
  const segs = rest.split("/").filter(Boolean).map((s) => {
    if (/^[$<{]|^%[A-Za-z]/.test(s)) return idClass;
    if (SEG_DIGITS.test(s)) return "\\d+";
    if (SEG_UUID.test(s)) return /[A-F]/.test(s) ? "[0-9a-fA-F-]{36}" : "[0-9a-f-]{36}";
    if (SEG_HEX24.test(s)) return /[A-F]/.test(s) ? "[0-9a-fA-F]{24}" : "[0-9a-f]{24}";
    if (SEG_WORD.test(s)) return s;
    return "[^/]+";
  });
  return `^${lead}${segs.join("/")}$`;
}

function isBulk(shape) {
  return /bulk|batch/i.test(shape);
}

function ownerFor(service, shape) {
  return service === "shortcut" && /^\^\/api\/v3\/(stories|epics)\/\\d\+/.test(shape);
}

const VERB = "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)";
const METHOD_RES = [
  new RegExp(`(?:^|\\s)-X\\s*['"]?${VERB}\\b`, "i"),
  new RegExp(`--request\\s+['"]?${VERB}\\b`, "i"),
  new RegExp(`-Method\\s+['"]?${VERB}\\b`, "i"),
  new RegExp(`\\bmethod\\s*[=:]\\s*['"]${VERB}['"]`, "i"),
  /\brequests\.(get|post|put|patch|delete)\(/i,
  /\.(get|post|put|patch|delete)\(\s*[`'"]https?:/i,
];
// A curl `-d` or a PowerShell `-Body` with no explicit verb is a POST; `-G` turns curl's
// `--data-urlencode` into a query string, so it is a GET.
// Case-sensitive on purpose: curl's `-D` (dump headers) is not `-d` (data).
const BODY_RE = /(?:^|\s)(?:-d|--data(?:-raw|-binary)?|--json|-F|--form)\b|(?:^|\s)-Body\b/;
const GET_FLAG_RE = /(?:^|\s)(?:-G|--get)\b|(?:^|\s)-[a-zA-Z]*G[a-zA-Z]*\s/;

/** Lines that continue the one command the URL's line belongs to. */
function commandBlock(lines, i, col) {
  let start = i;
  while (start > 0 && /[\\`^]\s*$/.test(lines[start - 1])) start--;
  let end = i;
  while (end < lines.length - 1 && /[\\`^]\s*$/.test(lines[end])) end++;
  let offset = col;
  for (let k = start; k < i; k++) offset += lines[k].length + 1;
  return { text: lines.slice(start, end + 1).join(" "), offset };
}

const CLIENT_RE = /\bcurl(?:\.exe)?\b|\bInvoke-(?:RestMethod|WebRequest)\b|\b(?:irm|iwr)\b/gi;

/**
 * The method of the call whose URL sits at `urlPos` in `block`. Only the one client invocation
 * the URL belongs to is read (its flags run to the next `|`, `;`, `&&` or `)`), so a `-d` of an
 * unrelated `cut -d=` in the same shell line is never taken for a request body.
 */
function methodOf({ text, offset }) {
  let k = -1;
  for (const m of text.slice(0, offset).matchAll(CLIENT_RE)) k = m.index;
  if (k < 0) {
    // No shell client before the URL: a script. Read the verb call on the line.
    for (const re of METHOD_RES.slice(3)) {
      const m = re.exec(text);
      if (m) return m[1].toUpperCase();
    }
    return "GET";
  }
  const after = text.slice(offset).search(/[|;)]|&&/);
  const seg = text.slice(k, after < 0 ? undefined : offset + after);
  for (const re of METHOD_RES) {
    const m = re.exec(seg);
    if (m) return m[1].toUpperCase();
  }
  if (GET_FLAG_RE.test(seg)) return "GET";
  return BODY_RE.test(seg) ? "POST" : "GET";
}

/**
 * Calls visible in one chat-written text. Returns `{calls: [{service, method, path}], linearOps: [name]}`.
 * `path` is the raw API path (still carrying ids); callers shape it.
 */
export function extractCalls(text) {
  const calls = [];
  const linearOps = [];
  const lines = text.split(/\r?\n/);
  const urlRe = /https?:\/\/(api\.app\.shortcut\.com|api\.linear\.app|api\.trello\.com|api\.figma\.com|api\.clockify\.me|api\.hubstaff\.com)(\/[^\s"'`\\)<>]*)?/gi;
  // The document often sits in a different string from the URL (a wrapper script, a variable),
  // so any chat-written text that mentions Linear and holds a mutation counts.
  let linearSeen = /linear/i.test(text) && /\bmutation\b/.test(text);
  lines.forEach((line, i) => {
    urlRe.lastIndex = 0;
    let m;
    while ((m = urlRe.exec(line))) {
      const info = HOSTS[m[1].toLowerCase()];
      let p = m[2] || "/";
      if (!p.startsWith(info.prefix) && !(info.service === "linear" && p.startsWith("/graphql"))) continue;
      // A script that builds the URL from a variable leaves only the prefix: no endpoint to seed.
      if (p === info.prefix || p.replace(/[?#].*/, "") === info.prefix) continue;
      if (info.service === "linear") {
        linearSeen = true;
        continue;
      }
      calls.push({ service: info.service, method: methodOf(commandBlock(lines, i, m.index)), path: p, prefix: info.prefix });
    }
  });
  if (linearSeen) {
    // A named root field after `mutation`, from the document text the chat sent.
    const re = /mutation\b[^{]*\{\s*([A-Za-z]+)/g;
    let m;
    while ((m = re.exec(text))) if (isLinearOpName(m[1])) linearOps.push(m[1]);
  }
  return { calls, linearOps };
}

/** Turns what the scan counted into seed rows. `counts` maps a row key to how often it was seen. */
export function buildRows(callCounts, linearCounts) {
  const rows = new Map();
  const note = (r) => rows.set(`${r.service} ${r.method || r.op} ${r.path || ""}`, r);
  for (const [key] of callCounts) {
    const [service, method, shape] = JSON.parse(key);
    // A write row with a wildcard segment would allow every sibling endpoint under it, which the
    // scan never saw: that row comes from the policy card (it prints the exact line), not the seed.
    if (!WRITE_METHODS.has(method) || isBulk(shape) || service === "linear" || shape.includes("[^/]+")) continue;
    note({ service, method, path: shape, require_owner: ownerFor(service, shape) });
  }
  for (const [op] of linearCounts) {
    if (Object.hasOwn(LINEAR_OPS, op)) note({ service: "linear", op, require_owner: LINEAR_OPS[op] });
  }
  // Explicit read row: Shortcut search is a POST that only reads, so GET-open does not cover it.
  note({ service: "shortcut", method: "POST", path: "^/api/v3/search$", require_owner: false });
  return [...rows.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Source code being written or run for the broker's own tests: URLs there are fixtures, not calls. */
const CODE_FIXTURE_RE = /mockito|#\[(?:tokio::)?test\]|engine_tests|policy_tests|\bfn \w+\(/;
const SCRIPT_FILE_RE = /\.(?:py|sh|ps1|js|mjs)$/i;

/**
 * The texts of one tool_use that are calls Joe's chat actually ran: shell commands, and the
 * body of a script file it wrote (the run is `python x.py`, the URL is in the file). File edits
 * to repo source are skipped, and so is anything that reads as test code.
 */
export function* callTexts(part) {
  const input = part?.input || {};
  const texts = [];
  if (typeof input.command === "string") texts.push(input.command);
  const file = String(input.file_path || input.path || "");
  if (typeof input.content === "string" && SCRIPT_FILE_RE.test(file) && !/src-tauri[\\/]/.test(file)) texts.push(input.content);
  for (const t of texts) if (!CODE_FIXTURE_RE.test(t)) yield t;
}

/** A Linear mutation root field is a lowerCamel verb phrase; this drops code words caught by the regex. */
export function isLinearOpName(name) {
  return /^[a-z][A-Za-z]*(?:Create|Update|Delete|Archive|Unarchive)$/.test(name);
}

async function* jsonlFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(full);
    else if (e.name.endsWith(".jsonl")) yield full;
  }
}

/** Scans transcripts and returns the counts. `now` is injectable for tests. */
export async function scan({ roots, days = 30, now = Date.now() }) {
  const cutoff = now - days * 86400000;
  const callCounts = new Map();
  const linearCounts = new Map();
  const stats = { files: 0, linesRead: 0, callsSeen: 0 };
  for (const root of roots) {
    for await (const file of jsonlFiles(root)) {
      const st = await fs.promises.stat(file);
      if (st.mtimeMs < cutoff) continue;
      stats.files++;
      const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
      for await (const line of rl) {
        // Cheap prefilter: most lines mention none of the six hosts.
        if (!/api\.(app\.shortcut|linear|trello|figma|clockify|hubstaff)\.|[Ll]inear/.test(line)) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        stats.linesRead++;
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        if (!Number.isNaN(ts) && ts < cutoff) continue;
        const content = obj?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part?.type !== "tool_use") continue;
          for (const s of callTexts(part)) {
            const { calls, linearOps } = extractCalls(s);
            for (const c of calls) {
              const key = JSON.stringify([c.service, c.method, pathShape(c.path, c.prefix, c.service)]);
              callCounts.set(key, (callCounts.get(key) || 0) + 1);
              stats.callsSeen++;
            }
            for (const op of linearOps) linearCounts.set(op, (linearCounts.get(op) || 0) + 1);
          }
        }
      }
    }
  }
  return { callCounts, linearCounts, stats };
}

function parseArgs(argv) {
  const a = { days: 30, projects: [], out: null, summaryOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") a.days = Number(argv[++i]);
    else if (argv[i] === "--projects") a.projects.push(argv[++i]);
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--summary-only") a.summaryOnly = true;
  }
  if (!a.projects.length) {
    for (const d of [".claude", ".claude-personal"]) {
      const p = path.join(os.homedir(), d, "projects");
      if (fs.existsSync(p)) a.projects.push(p);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = args.out || path.join(here, "..", "src-tauri", "src", "daemon", "broker", "broker-policy-seed.json");
  const { callCounts, linearCounts, stats } = await scan({ roots: args.projects, days: args.days });
  const rows = buildRows(callCounts, linearCounts);
  const log = (s) => console.log(redact(s));
  log(`scanned ${stats.files} transcript files from the last ${args.days} days, ${stats.callsSeen} calls to the six services`);
  log("seen (service method shape: count):");
  for (const [k, n] of [...callCounts].sort()) {
    const [s, m, sh] = JSON.parse(k);
    log(`  ${s} ${m} ${sh}: ${n}`);
  }
  for (const [op, n] of [...linearCounts].sort()) log(`  linear mutation ${op}: ${n}${Object.hasOwn(LINEAR_OPS, op) ? "" : " (not seedable)"}`);
  log(`seed rows: ${rows.length}`);
  if (args.summaryOnly) return;
  const body = { version: 1, generated: new Date().toISOString().slice(0, 10), window_days: args.days, rows };
  fs.writeFileSync(out, redact(JSON.stringify(body, null, 2)) + "\n");
  log(`wrote ${path.relative(process.cwd(), out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(redact(e?.message || e));
    process.exit(1);
  });
}
