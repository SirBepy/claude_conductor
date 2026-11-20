#!/usr/bin/env node
// test-progress: runs a test command (vitest or cargo test), passes its output through
// untouched, and reports pass/fail counts to the Conductor daemon while it runs, so the
// chat's dashboard shows a live Test progress card (pc-1684).
//
//   node scripts/test-progress.mjs [--runner vitest|cargo] [--session ID] [--url URL] -- <command> [args...]
//
//   node scripts/test-progress.mjs -- pnpm vitest run
//   node scripts/test-progress.mjs -- cargo test --manifest-path src-tauri/Cargo.toml
//
// Where it reports: CC_BROKER_URL (the daemon's loopback address, set for every Conductor chat;
// an address, not a credential). Which chat: --session, else CC_SESSION_ID, else the session id
// that is the second field of CC_BROKER_TOKEN (`ccb1.<session>.<role>...`, documented as not
// secret). The token itself is never sent anywhere: the daemon route takes a session id only and
// accepts it only for a chat it knows. Outside a Conductor chat (no session id) the command just
// runs, with one line on stderr saying nothing is reported.
//
// Reporting never changes the run: a daemon that is down, slow or refusing is ignored (three
// failures in a row stop the reporting), the output is the command's own, and the exit code is
// the command's own. Nothing here raises anything in the chat; the dashboard only shows counts.

import { spawn } from "node:child_process";
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

const MAX_FAILING = 12;
const MAX_PENDING_LINE = 64 * 1024;
/** The daemon marks a run that has been silent this long as stopped, so a quiet run beats it. */
const HEARTBEAT_MS = 5000;
/** A burst of test lines is one report. */
const THROTTLE_MS = 250;
const POST_TIMEOUT_MS = 3000;
const GIVE_UP_AFTER = 3;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => s.replace(ANSI, "");

/** vitest or cargo from the command line, or null when it is neither (then --runner is needed). */
export function detectRunner(cmd) {
  const words = cmd.map((w) => String(w).toLowerCase());
  if (words.some((w) => /(^|[\\/])vitest(\.mjs|\.js|\.cmd)?$/.test(w))) return "vitest";
  if (words.some((w) => /(^|[\\/])cargo(\.exe)?$/.test(w)) && words.includes("test")) return "cargo test";
  return null;
}

/** Reads a runner's output a line at a time and keeps the counts. */
export function createTracker(runner) {
  const t = { runner, passed: 0, failed: 0, total: 0, failing: [], failingMore: 0, summary: false };
  const addFailing = (name) => {
    if (!name || t.failing.includes(name)) return;
    if (t.failing.length < MAX_FAILING) t.failing.push(name);
    else t.failingMore += 1;
  };
  let inVitestFile = false;
  t.feed = (raw) => {
    const line = stripAnsi(raw).replace(/\r$/, "");
    if (runner === "vitest") {
      // ` ✓ tests/a.test.mjs (12 tests) 5ms`, ` ❯ b.test.mjs (4 tests | 1 failed | 1 skipped) 12ms`
      // A file line is indented one space; a failing test's own `×` line is indented deeper and
      // can carry "(2 tests)" in its name, so it must not match here.
      const file = /^\s{0,2}[✓❯↓]\s+\S.*?\((\d+) tests?(?: \| ([^)]*))?\)/.exec(line);
      if (file) {
        const n = Number(file[1]);
        const failed = Number(/(\d+) failed/.exec(file[2] ?? "")?.[1] ?? 0);
        const skipped = Number(/(\d+) skipped/.exec(file[2] ?? "")?.[1] ?? 0);
        const todo = Number(/(\d+) todo/.exec(file[2] ?? "")?.[1] ?? 0);
        t.failed += failed;
        t.passed += Math.max(0, n - failed - skipped - todo);
        inVitestFile = failed > 0;
        return;
      }
      // The failed tests of a file are listed right under it as `   × suite > name 4ms`.
      const bad = /^\s{2,}[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/.exec(line);
      if (bad && inVitestFile) {
        addFailing(bad[1]);
        return;
      }
      if (/^\s*$/.test(line) || /^\s{2,}→/.test(line)) return;
      inVitestFile = false;
      // `      Tests  1 failed | 10 passed | 2 skipped (13)`: the run's own totals replace the running sum.
      const sum = /^\s*Tests\s+(.*?)\s*\(\d+\)\s*$/.exec(line);
      if (sum) {
        t.failed = Number(/(\d+) failed/.exec(sum[1])?.[1] ?? 0);
        t.passed = Number(/(\d+) passed/.exec(sum[1])?.[1] ?? 0);
        t.summary = true;
      }
      return;
    }
    // cargo test
    const running = /^running (\d+) tests?$/.exec(line);
    if (running) {
      t.total += Number(running[1]);
      return;
    }
    const one = /^test (.+?) \.\.\. (ok|FAILED|ignored)\b/.exec(line);
    if (one) {
      if (one[2] === "ok") t.passed += 1;
      else if (one[2] === "FAILED") {
        t.failed += 1;
        addFailing(one[1]);
      } else if (t.total > 0) t.total -= 1;
    }
  };
  /** The body the daemon takes. `state` is running, or how the command ended. */
  t.report = (state) => {
    // vitest announces no total up front: a finished run's total is what ran.
    const total = runner === "vitest" ? (state === "running" ? 0 : t.passed + t.failed) : t.total;
    return { runner, passed: t.passed, failed: t.failed, total, failing: t.failing, failing_more: t.failingMore, state };
  };
  return t;
}

/** How a finished command is reported: a non-zero exit with nothing failed (a compile error,
 *  a crash, a config problem) is an error, not a pass. */
export function endState(t, code) {
  if (code === 0 && t.failed === 0) return "passed";
  return t.failed > 0 ? "failed" : "error";
}

/** The chat's id: --session, else CC_SESSION_ID, else the second field of the broker token. */
export function sessionFrom(opts, env) {
  if (opts.session) return opts.session;
  if (env.CC_SESSION_ID) return env.CC_SESSION_ID;
  const parts = String(env.CC_BROKER_TOKEN ?? "").split(".");
  return parts[0] === "ccb1" && parts[1] ? parts[1] : "";
}

export function parseArgs(argv) {
  const opts = { runner: "", session: "", url: "", cmd: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { i += 1; break; }
    if (a === "--runner" || a === "--session" || a === "--url") opts[a.slice(2)] = argv[++i] ?? "";
    else break;
  }
  opts.cmd = argv.slice(i);
  return opts;
}

/** One POST to the daemon's loopback route; resolves true when it answered ok. No proxy: this is loopback. */
function post(base, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL("/hooks/test-progress", base); } catch { resolve(false); return; }
    const data = JSON.stringify(body);
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", timeout: POST_TIMEOUT_MS,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let out = "";
        res.on("data", (c) => { out += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(out).ok === true); } catch { resolve(false); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end(data);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd.length === 0) {
    console.error("usage: test-progress.mjs [--runner vitest|cargo] [--session ID] [--url URL] -- <command> [args...]");
    process.exit(2);
  }
  const runner = opts.runner === "cargo" ? "cargo test" : opts.runner || detectRunner(opts.cmd);
  if (runner !== "vitest" && runner !== "cargo test") {
    console.error("test-progress: cannot tell the runner from the command; pass --runner vitest or --runner cargo");
    process.exit(2);
  }
  const base = opts.url || process.env.CC_BROKER_URL || "http://127.0.0.1:27182";
  const session = sessionFrom(opts, process.env);
  if (!session) console.error("test-progress: no chat session id (not inside a Conductor chat), running without reporting");

  const t = createTracker(runner);
  let fails = 0;
  let last = "";
  let timer = null;
  let chain = Promise.resolve();
  const send = (state) => {
    if (!session || fails >= GIVE_UP_AFTER) return chain;
    const body = { session_id: session, ...t.report(state) };
    chain = chain.then(async () => {
      if (await post(base, body)) fails = 0;
      else if (++fails === GIVE_UP_AFTER) console.error("test-progress: the daemon is not answering, no longer reporting");
    });
    return chain;
  };
  const changed = () => {
    const sig = JSON.stringify(t.report("running"));
    if (sig === last || timer) return;
    timer = setTimeout(() => { timer = null; last = JSON.stringify(t.report("running")); void send("running"); }, THROTTLE_MS);
  };

  void send("running");
  const beat = setInterval(() => void send("running"), HEARTBEAT_MS);

  const [file, ...args] = opts.cmd;
  // On Windows a bare `pnpm` is `pnpm.cmd`, which only a shell finds; one quoted command string
  // keeps every argument whole (an args array with a shell is joined unquoted).
  const quote = (w) => (/[\s"&|<>^()]/.test(w) ? `"${w.replace(/"/g, '\\"')}"` : w);
  const child = process.platform === "win32"
    ? spawn(opts.cmd.map(quote).join(" "), { stdio: ["inherit", "pipe", "pipe"], shell: true })
    : spawn(file, args, { stdio: ["inherit", "pipe", "pipe"] });
  const lines = (stream, out) => {
    let rest = "";
    // A decoder keeps a multibyte character (the ✓ and × markers) whole across chunk boundaries.
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk) => {
      out.write(chunk);
      rest += decoder.write(chunk);
      const parts = rest.split("\n");
      // A child that never ends a line must not grow this without bound; the tail is all a parser needs.
      rest = (parts.pop() ?? "").slice(-MAX_PENDING_LINE);
      for (const p of parts) t.feed(p);
      changed();
    });
    stream.on("end", () => {
      rest += decoder.end();
      if (rest) t.feed(rest);
    });
  };
  lines(child.stdout, process.stdout);
  lines(child.stderr, process.stderr);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

  const code = await new Promise((resolve) => {
    child.on("error", (e) => { console.error(`test-progress: could not start ${file}: ${e.message}`); resolve(127); });
    child.on("close", (c, signal) => resolve(c ?? (signal ? 130 : 1)));
  });
  clearInterval(beat);
  if (timer) clearTimeout(timer);
  await send(endState(t, code));
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
