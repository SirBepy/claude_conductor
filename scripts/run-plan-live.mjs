// Run plan live run (run plans, step 6 of the build): ONE billed real-claude 3-chain run with the main chat
// compacted mid-run, on a PRIVATE daemon.
//
//   node scripts/run-plan-live.mjs --daemon <path to cc-conductor-daemon.exe> [--keep] [--config-dir <claude config dir>]
//
// What it does: brings up a private daemon (own data dir under C:\tmp, own instance label, own ports,
// CC_DAEMON_NO_AUTOSTART) with the REAL `claude` as its CLI, started from a main chat with Use subchats on.
// The main chat is sent ONE prompt that makes it call run_plan with 3 chains of 2 trivial read-only
// subs and one main end step. The rig then calls `compact_now` on the main chat while the run is open
// and waits for the run file to reach `done` with no further message to the main chat: the daemon's
// own wakes must carry the main chat through the end step. Pass = run done, every step done, the
// compaction ran while at least one lane was not done, and the rig sent the main chat exactly one message.
//
// Safety: bills real `claude` turns on the subscription account named by --config-dir (default
// ~/.claude-personal): one main chat, 6 one-word subs, one save turn and one /compact. The account entry
// REFERENCES the config dir (credentials are never copied or read; only the email and org uuid of
// `.claude.json`'s oauthAccount are copied so the drift guard passes). No API key variable reaches the
// daemon. Teardown kills only the daemon PID this script started, deletes the scratch folder and the
// transcript folders the run left in the config dir (names starting with the scratch folder's munged name).
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const keep = argv.includes("--keep");
const daemonSrc = flag("--daemon");
const configDir = flag("--config-dir") || path.join(os.homedir(), ".claude-personal");
if (!daemonSrc || !fs.existsSync(daemonSrc)) { console.error("usage: node scripts/run-plan-live.mjs --daemon <cc-conductor-daemon.exe> [--keep] [--config-dir <dir>]"); process.exit(2); }
if (process.platform !== "win32") { console.error("the rig drives the daemon over its Windows named pipe"); process.exit(2); }

const id = crypto.randomBytes(4).toString("hex");
const instance = `rplive-${id}`;
const root = path.join("C:\\tmp", `run-plan-live-${id}`);
const dataDir = path.join(root, "data");
const projectDir = path.join(root, "projects", "scratch-proj");
const binDir = path.join(root, "bin");
const reportPath = path.join("C:\\tmp", `run-plan-live-${id}.report.json`);
for (const d of [dataDir, projectDir, binDir]) fs.mkdirSync(d, { recursive: true });

let daemon = null, tornDown = false;
const munged = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
function teardown() {
  if (tornDown) return; tornDown = true;
  if (daemon && daemon.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(daemon.pid)], { stdio: "ignore" });
  if (keep) return;
  const projects = path.join(configDir, "projects");
  const prefix = munged(path.join(root));
  try {
    for (const d of fs.readdirSync(projects)) if (d.startsWith(prefix)) for (let i = 0; i < 20; i++) { try { fs.rmSync(path.join(projects, d), { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } }
  } catch {}
  for (let i = 0; i < 20; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } }
}
process.on("exit", teardown);
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => { teardown(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const log = (...a) => console.log(stamp(), ...a);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

// ---- data dir: one account that REFERENCES the real config dir, one scratch project ----
const oauth = JSON.parse(fs.readFileSync(path.join(configDir, ".claude.json"), "utf8")).oauthAccount || {};
const email = oauth.emailAddress, org = oauth.organizationUuid;
if (!email || !org) { console.error("the config dir's .claude.json has no oauthAccount email/org"); process.exit(2); }
const git = (...a) => spawnSync("git", ["-C", projectDir, ...a], { encoding: "utf8" });
fs.writeFileSync(path.join(projectDir, "README.md"), "# scratch\n");
git("init", "-q"); git("add", "-A"); git("-c", "user.email=rp@local", "-c", "user.name=rp", "commit", "-q", "-m", "seed");
const acct = crypto.randomUUID(), nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify([{ id: acct, label: "rplive", colour: "", icon: "", config_dir: configDir, chrome_profile_dir: path.join(dataDir, "chrome-profile"), email, org_uuid: org, subscription_tier: "", created_at: nowIso, fleet_eligible: false }]));
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ projects: [{ id: crypto.randomUUID(), path: projectDir, name: "scratch-proj", created_at: nowIso }], default_account_id: acct }));
fs.writeFileSync(path.join(dataDir, "remote-devices.json"), '{"devices":[],"enabled":true,"schema":1}');

const freePort = () => new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const remotePort = await freePort();
const exe = path.join(binDir, "cc-conductor-daemon.exe");
fs.copyFileSync(daemonSrc, exe);
const logOut = fs.openSync(path.join(root, "daemon.out.log"), "w"), logErr = fs.openSync(path.join(root, "daemon.err.log"), "w");
const env = { ...process.env, CC_DATA_DIR: dataDir, CC_DAEMON_INSTANCE: instance, CC_REMOTE_PORT: String(remotePort), CC_DAEMON_NO_AUTOSTART: "1", RUST_LOG: "info" };
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CC_CLAUDE_BIN", "CLAUDE_CONFIG_DIR"]) delete env[k];
daemon = spawn(exe, [], { env, stdio: ["ignore", logOut, logErr], windowsHide: true });

const pipeName = `\\\\.\\pipe\\cc-conductor-daemon-${process.env.USERNAME || "default"}-${instance}`;
function frame(obj) { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); }
async function connectPipe() {
  const deadline = Date.now() + 60000;
  for (;;) {
    try { return await new Promise((res, rej) => { const s = createConnection(pipeName); s.once("connect", () => res(s)); s.once("error", rej); }); }
    catch (e) { if (Date.now() > deadline) throw new Error("the daemon's pipe never came up: " + e.message); await sleep(300); }
  }
}
const pending = new Map(); let nextId = 1; let rbuf = Buffer.alloc(0);
const sock = await connectPipe();
sock.on("data", (d) => {
  rbuf = Buffer.concat([rbuf, d]);
  while (rbuf.length >= 4 && rbuf.length >= 4 + rbuf.readUInt32BE(0)) {
    const n = rbuf.readUInt32BE(0); const msg = JSON.parse(rbuf.subarray(4, 4 + n).toString("utf8")); rbuf = rbuf.subarray(4 + n);
    const w = pending.get(msg.id); if (w) { pending.delete(msg.id); w(msg); }
  }
});
sock.write(frame({ protocol_version: 1 }));
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const i = nextId++; const t = setTimeout(() => { pending.delete(i); rej(new Error(`rpc ${method} timed out`)); }, 60000);
  pending.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result); });
  sock.write(frame({ jsonrpc: "2.0", id: i, method, params }));
});

// ---- the one prompt: tiny, quotes no secret ----
// A lane runs one `sleep` so the run outlasts the compaction (a bare "say ok" lane is done in 13 s).
const sub = (n, after) => ({ id: n, title: `Say ok (${n})`, ...(after ? { after: [after] } : {}), spawn: { name: `rp-${n}`, task: `Run the shell command "sleep ${after ? 50 : 20}" once, then reply with the single word ok, then finish. Use no other tool.`, goal: "Live-rig lane", done_when: "you said ok", writes: false, review: false, report_back: false, model: "sonnet", effort: "low" } });
const plan = { action: "create", title: "Live rig 3 chains", goal: "Run three chains of two trivial lanes, then close the run.", steps: [sub("a1"), sub("a2", "a1"), sub("b1"), sub("b2", "b1"), sub("c1"), sub("c2", "c1"), { id: "final", title: "Closing step: call run_plan done on this step", owner: "main", after: ["a2", "b2", "c2"] }] };
const prompt = `Call the run_plan tool exactly once with this JSON as its arguments, then end your turn with no other text and no polling. When the daemon later tells you the step "final" is ready, call run_plan with action done and step final, then end your turn.\n\n${JSON.stringify(plan)}`;

let failed = false;
const timeline = [];
const report = { instance, id, plan: plan.steps.map((s) => s.id), timeline, compaction: null, rigMessages: 0 };
try {
  const hooksPortFile = path.join(dataDir, `hooks_port-${instance}.txt`);
  for (let i = 0; i < 100 && !fs.existsSync(hooksPortFile); i++) await sleep(300);
  log("daemon up, instance", instance);
  const main = (await rpc("start_session", { cwd: projectDir, model: "sonnet", effort: "low", account_id: acct, subchats_on: true, auto_accept: true })).session_id;
  report.main = main; log("main chat", main);
  report.rigMessages++;
  await rpc("send_message", { session_id: main, text: prompt });

  const subsDir = path.join(dataDir, "subchats");
  const runFile = () => { try { const f = fs.readdirSync(subsDir).find((n) => n.endsWith(".run.json")); return f ? path.join(subsDir, f) : null; } catch { return null; } };
  const readRun = () => { const f = runFile(); if (!f) return null; try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const snap = (r) => r.steps.map((s) => `${s.id}:${s.status}`).join(" ");
  let lastSnap = "";
  const watch = (r) => { if (!r) return; const s = `${r.status} | ${snap(r)} | watch=${(r.watch || []).length} seen=${(r.seen || []).join(",")}`; if (s !== lastSnap) { lastSnap = s; timeline.push({ at: Date.now() - t0, snap: s }); log("run:", s); } };

  // Wait for the plan, then compact the moment the main chat is idle and the run is still open.
  let r = null;
  for (let i = 0; i < 300 && !(r = readRun()); i++) await sleep(1000);
  check("the main chat created the run plan", !!r && r.steps.length === 7, r ? snap(r) : "no run file");
  if (!r) throw new Error("no run plan was created; the main chat's transcript is under " + path.join(configDir, "projects"));
  watch(r);
  let compacted = null;
  for (let i = 0; i < 400 && !compacted; i++) {
    r = readRun(); watch(r);
    if (r && r.status !== "open") break;
    const res = await rpc("compact_now", { session_id: main });
    if (res.ok) { compacted = { at: Date.now() - t0, run: r ? snap(r) : null, openLanes: r ? r.steps.filter((s) => s.status !== "done" && s.status !== "skipped").length : null }; log("compact_now ok; run was:", compacted.run); }
    else { if (i % 5 === 0) log("compact_now refused:", res.error); await sleep(2000); }
  }
  report.compaction = compacted;
  check("compact_now started a compaction while the run was open", !!compacted);
  check("at least one step was not done when the compaction started", !!compacted && compacted.openLanes > 0, compacted ? compacted.run : "");

  // From here the rig sends NOTHING: only the daemon's wakes can move the run.
  const deadline = Date.now() + 15 * 60000;
  for (; Date.now() < deadline; await sleep(2000)) { r = readRun(); watch(r); if (r && r.status === "done" && (r.seen || []).includes("end")) break; }
  await sleep(3000); r = readRun(); watch(r);
  report.final = r;
  check("the run reached done", !!r && r.status === "done", r ? r.status : "no run");
  check("every step is done", !!r && r.steps.every((s) => s.status === "done"), r ? snap(r) : "");
  check("the end alert was heard", !!r && (r.seen || []).includes("end"), r ? JSON.stringify(r.seen) : "");
  check("the rig sent the main chat exactly one message", report.rigMessages === 1);
  const inst = (await rpc("list_instances")).find((i) => i.session_id === main);
  report.mainRow = inst ? { awaiting: inst.awaiting, status: inst.status } : null;

  // Evidence from the CLI's own transcript: what reached the main chat besides the rig's one prompt.
  const tdir = path.join(configDir, "projects", munged(projectDir));
  const tfile = path.join(tdir, `${main}.jsonl`);
  const wakes = [];
  if (fs.existsSync(tfile)) {
    for (const line of fs.readFileSync(tfile, "utf8").split("\n").filter(Boolean)) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const c = j.message && j.message.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text || "").join("") : "";
      if (j.type === "user" && text) wakes.push({ ts: j.timestamp, text: text.slice(0, 220) });
      if (j.isCompactSummary || (j.type === "system" && /compact/i.test(j.subtype || ""))) wakes.push({ ts: j.timestamp, marker: j.subtype || "compactSummary" });
    }
  }
  report.mainTranscriptUserTurns = wakes;
  log("main transcript user turns:", wakes.length);
  for (const w of wakes) console.log("   ", w.ts, w.marker ? `[${w.marker}]` : JSON.stringify(w.text));
} catch (e) {
  failed = true; console.error("RIG ERROR: " + (e && e.stack || e));
  try { console.error(fs.readFileSync(path.join(root, "daemon.err.log"), "utf8").split("\n").slice(-30).join("\n")); } catch {}
} finally {
  try { sock.destroy(); } catch {}
  report.results = results;
  try { fs.copyFileSync(path.join(root, "daemon.err.log"), reportPath.replace(".report.json", ".daemon.err.log")); } catch {}
  try { fs.copyFileSync(path.join(root, "daemon.out.log"), reportPath.replace(".report.json", ".daemon.out.log")); } catch {}
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  teardown();
}
const bad = results.filter((x) => !x.ok);
console.log(`\nRun plan live run: ${results.length - bad.length}/${results.length} checks passed${failed ? ", rig error" : ""}; report ${reportPath}`);
process.exit(failed || bad.length ? 1 : 0);
