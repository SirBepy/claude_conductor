// Broker Gate 0, live run (docs/api-broker-plan.md step 8, docs/architecture/api-broker.md "Gate 0").
//
//   node scripts/broker-gate0.mjs --daemon <path to cc-conductor-daemon.exe> [--keep]
//
// Brings up a PRIVATE daemon process (own data dir, own instance label, ephemeral hooks port, its own
// remote port), with the fake `claude` of e2e/fixtures/fake-claude as its CLI, and drives four kinds of
// chat through it: an attended chat, a hidden sub, an autopilot chat and a chat a phone starts and
// drives over /api/rpc. Each one gets a message that makes the fake do what a `claude` child does
// around a tool call (e2e/fixtures/fake-claude/broker-probe.cjs): read the argv's --allowedTools, call
// api_read / api_write through the real MCP child and through the loopback front with the chat's own
// CC_BROKER_TOKEN. The rig polls the daemon's open prompts the whole time and passes only when no
// probe chat ever had one, a control chat DID raise one (so the poll can see a card), every call
// reached the engine (audit lines) and `broker_friction` counts exactly the denials those calls made.
//
// Safety: no billed `claude` (the CLI is the fake), no network and no real token. The three probe
// calls stop before the secret read (an unbound service, a non-relative path, a DELETE no policy row
// allows), because the daemon's secret source includes the user's real ~/.claude/.env (`dirs::home_dir`
// ignores USERPROFILE on Windows) and its service hosts are pinned. Teardown kills only the daemon PID
// this script started, then deletes the scratch folder. Exit code 0 = Gate 0 passed.
//
// What this does NOT prove: that the real `claude` CLI honours --allowedTools for an MCP tool in each
// mode. The fake applies the rule the code's own comments state; only a billed run settles it.
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const keep = argv.includes("--keep");
const daemonSrc = flag("--daemon") || process.env.GATE0_DAEMON_EXE;
if (!daemonSrc || !fs.existsSync(daemonSrc)) {
  console.error("usage: node scripts/broker-gate0.mjs --daemon <cc-conductor-daemon.exe> [--keep]  (build the daemon first; this script never runs cargo)");
  process.exit(2);
}
if (process.platform !== "win32") { console.error("the rig drives the daemon over its Windows named pipe"); process.exit(2); }

const id = crypto.randomBytes(4).toString("hex");
const instance = `gate0-${id}`;
const root = path.join(flag("--root") || process.env.GATE0_ROOT || os.tmpdir(), `broker-gate0-${id}`);
const dataDir = path.join(root, "data");
const projectDir = path.join(root, "projects", "scratch-proj");
const probeDir = path.join(root, "probes");
const binDir = path.join(root, "bin");
for (const d of [dataDir, projectDir, probeDir, binDir]) fs.mkdirSync(d, { recursive: true });
// Registered before anything below can fail, so an early exit never leaves the scratch folder behind.
let daemon = null;
let tornDown = false;
function teardown() {
  if (tornDown) return; tornDown = true;
  // Only the PID this script started, with its children (the fake claude and its MCP children).
  if (daemon && daemon.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(daemon.pid)], { stdio: "ignore" });
  if (!keep) for (let i = 0; i < 20; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } }
}
process.on("exit", teardown);
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => { teardown(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

// ---- the fake claude (an .exe: the system prompt of a chat is over cmd.exe's 8191 characters) ----
const built = spawnSync("powershell", ["-NoProfile", "-File", path.join(repo, "scripts", "build-fake-claude.ps1")], { encoding: "utf8", cwd: repo });
const fakeExe = path.join(repo, "e2e", "fixtures", "fake-claude", "claude.exe");
if (built.status !== 0 || !fs.existsSync(fakeExe)) { console.error("could not build the fake claude: " + (built.stderr || built.stdout)); process.exit(2); }

// ---- the private data dir, the way scripts/phone-verify.ps1 seeds one ----
const git = (...a) => spawnSync("git", ["-C", projectDir, ...a], { encoding: "utf8" });
fs.writeFileSync(path.join(projectDir, "README.md"), "# scratch\n");
git("init", "-q"); git("add", "-A"); git("-c", "user.email=g0@local", "-c", "user.name=g0", "commit", "-q", "-m", "seed");
const acct = crypto.randomUUID(), nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify([{ id: acct, label: "gate0", colour: "", icon: "", config_dir: path.join(dataDir, "claude-config"), chrome_profile_dir: path.join(dataDir, "chrome-profile"), email: "gate0@example.com", org_uuid: crypto.randomUUID(), subscription_tier: "", created_at: nowIso, fleet_eligible: false }]));
// The pre-spawn guards want a logged-in config dir: an expiry for the drift guard, and a non-blank
// token pair or the spawn is refused as "a blanked OAuth record". Random throwaway values (not a
// real login, never sent anywhere) and a far-future expiry give nothing a reason to refresh;
// the fake claude never reads the file.
const farFuture = Date.now() + 10 * 365 * 24 * 3600 * 1000;
fs.mkdirSync(path.join(dataDir, "claude-config"), { recursive: true });
fs.writeFileSync(path.join(dataDir, "claude-config", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: crypto.randomBytes(12).toString("hex"), refreshToken: crypto.randomBytes(12).toString("hex"), expiresAt: farFuture, refreshTokenExpiresAt: farFuture } }));
// The project is bound to Figma only, stated outright: the probe's Shortcut call must be an unbound-service
// denial (it stops before the secret read), and a tracker resolving from the scratch folder must not change that.
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ projects: [{ id: crypto.randomUUID(), path: projectDir, name: "scratch-proj", created_at: nowIso, broker_services: ["figma"] }], default_account_id: acct }));
fs.writeFileSync(path.join(dataDir, "remote-devices.json"), '{"devices":[],"enabled":true,"schema":1}');

const freePort = () => new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const remotePort = await freePort();

// A private copy, so a later `cargo build` is never blocked by this rig holding the exe.
const exe = path.join(binDir, "cc-conductor-daemon.exe");
fs.copyFileSync(daemonSrc, exe);
const logOut = fs.openSync(path.join(root, "daemon.out.log"), "w"), logErr = fs.openSync(path.join(root, "daemon.err.log"), "w");
const env = { ...process.env, CC_DATA_DIR: dataDir, CC_DAEMON_INSTANCE: instance, CC_REMOTE_PORT: String(remotePort), CC_DAEMON_NO_AUTOSTART: "1", CC_CLAUDE_BIN: fakeExe, FAKE_BROKER_PROBE_DIR: probeDir, RUST_LOG: "info" };
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete env[k];
daemon = spawn(exe, [], { env, stdio: ["ignore", logOut, logErr], windowsHide: true });

// ---- the daemon's pipe ----
const pipeName = `\\\\.\\pipe\\cc-conductor-daemon-${process.env.USERNAME || "default"}-${instance}`;
function frame(obj) { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); }
async function connectPipe() {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      return await new Promise((res, rej) => { const s = createConnection(pipeName); s.once("connect", () => res(s)); s.once("error", rej); });
    } catch (e) { if (Date.now() > deadline) throw new Error("the daemon's pipe never came up: " + e.message); await sleep(300); }
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
  const i = nextId++; const t = setTimeout(() => { pending.delete(i); rej(new Error(`rpc ${method} timed out`)); }, 30000);
  pending.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result); });
  sock.write(frame({ jsonrpc: "2.0", id: i, method, params }));
});
const hooksPortFile = path.join(dataDir, `hooks_port-${instance}.txt`);
for (let i = 0; i < 100 && !fs.existsSync(hooksPortFile); i++) await sleep(300);
const hooksPort = Number(fs.readFileSync(hooksPortFile, "utf8").trim());
const remoteToken = await (async () => { const f = path.join(dataDir, "remote-access.json"); for (let i = 0; i < 100 && !fs.existsSync(f); i++) await sleep(300); return JSON.parse(fs.readFileSync(f, "utf8")).token; })();

function post(port, route, body, bearer) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...(bearer ? { authorization: "Bearer " + bearer } : {}) } }, (r) => {
      let t = ""; r.setEncoding("utf8"); r.on("data", (d) => (t += d)); r.on("end", () => { try { res({ status: r.statusCode, body: JSON.parse(t) }); } catch { res({ status: r.statusCode, body: t }); } });
    });
    req.on("error", rej); req.end(data);
  });
}
// The phone's door: the remote server's /api/rpc with the device token (the Phone transport).
const phoneRpc = async (method, params) => { const r = await post(remotePort, "/api/rpc", { method, params }, remoteToken); if (r.status !== 200) throw new Error(`phone ${method}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };

// ---- the card watch: every open prompt, per chat, for the whole run ----
const cardsBySession = new Map();
let watching = true;
(async () => {
  while (watching) {
    try {
      for (const p of await rpc("list_pending_prompts")) {
        const sid = (p.payload && (p.payload.session_id || p.session_id)) || "?";
        const set = cardsBySession.get(sid) || new Set(); set.add(`${p.kind || p.type || "prompt"}:${p.id}`); cardsBySession.set(sid, set);
      }
    } catch {}
    await sleep(100);
  }
})();

const reportOf = async (sid, mode, ms = 90000) => {
  const f = path.join(probeDir, `${sid}-${mode}.json`);
  for (const t = Date.now() + ms; Date.now() < t;) { if (fs.existsSync(f)) { await sleep(200); return JSON.parse(fs.readFileSync(f, "utf8")); } await sleep(300); }
  const errs = path.join(probeDir, "errors.log");
  throw new Error(`no ${mode} report for ${sid}` + (fs.existsSync(errs) ? `: ${fs.readFileSync(errs, "utf8").slice(0, 400)}` : ""));
};
const start = async (extra = {}, via = rpc) => (await via("start_session", { cwd: projectDir, model: "sonnet", effort: "low", account_id: acct, ...extra })).session_id;
const send = (sid, text, via = rpc) => via("send_message", { session_id: sid, text });
const instanceOf = async (sid) => (await rpc("list_instances")).find((i) => i.session_id === sid);

let failed = false;
try {
  // Attended: started from the desktop pipe, auto-accept off (the case that would show a card for an unlisted tool).
  const attended = await start({ auto_accept: false });
  await send(attended, "BROKER_PROBE attended");

  // Phone-driven: the phone's own RPC door starts and drives it; the broker is reached by the chat's child on this PC.
  const phone = await start({ auto_accept: false }, phoneRpc);
  await send(phone, "BROKER_PROBE phone", phoneRpc);
  const phoneRow = await instanceOf(phone);
  check("the phone-driven chat is a Remote chat in the registry", phoneRow && phoneRow.is_remote === true, JSON.stringify({ is_remote: phoneRow && phoneRow.is_remote }));

  // Autopilot: a turn whose reply carries the marker turns it on; the probe is the next message.
  const auto = await start({ auto_accept: false });
  await send(auto, "AUTOPILOT_ON please");
  for (let i = 0, on = false; !on; i++) { on = !!(await instanceOf(auto) || {}).autopilot; if (!on) { if (i > 100) throw new Error("autopilot never turned on"); await sleep(300); } }
  await send(auto, "BROKER_PROBE autopilot");

  // Hidden sub: a main chat with Use subchats on spawns a read-only sub whose brief holds the probe words.
  const main = await start({ auto_accept: false, subchats_on: true });
  await send(main, "hello main");
  await sleep(1500);
  const spawned = await post(hooksPort, "/chat/spawn", { session_id: main, cwd: projectDir, name: "g0-sub", task: "BROKER_PROBE hidden sub: call the broker", goal: "Gate 0 probe", done_when: "the probe answers", writes: false, report_back: false });
  const subId = (spawned.body && (spawned.body.session_id || spawned.body.id || (spawned.body.sub && spawned.body.sub.session_id))) || null;
  check("a main chat spawned a hidden sub", !!subId, JSON.stringify(spawned.body).slice(0, 200));

  const kinds = [["attended", attended], ["phone-driven", phone], ["autopilot", auto], ["hidden sub", subId]];
  const reports = {};
  for (const [name, sid] of kinds) reports[name] = sid ? await reportOf(sid, "probe") : null;

  // Control: a tool the argv does NOT pre-approve goes to the relay and shows up in the card watch.
  const control = await start({ auto_accept: false });
  await send(control, "BROKER_CONTROL");
  let controlCard = null;
  for (let i = 0; i < 200 && !controlCard; i++) { const p = (await rpc("list_pending_prompts")).find((x) => x.payload && x.payload.session_id === control); if (p) controlCard = p; else await sleep(150); }
  check("control: the watch sees a permission card for a tool that is not pre-approved", !!controlCard);
  if (controlCard) await rpc("respond_permission", { request_id: controlCard.id, allow: false, message: "gate 0 control" });
  const controlReport = await reportOf(control, "control");
  check("control: the fake asked the relay exactly once", controlReport.relay_calls === 1, JSON.stringify(controlReport.calls));

  await sleep(1000);
  watching = false;
  for (const [name, sid] of kinds) {
    const rep = reports[name];
    if (!rep) { check(`${name}: probe ran`, false); continue; }
    const cards = [...(cardsBySession.get(sid) || [])];
    check(`${name}: zero permission cards`, cards.length === 0, cards.join(","));
    check(`${name}: the argv pre-approves api_read and api_write`, rep.allowed_api_read && rep.allowed_api_write);
    check(`${name}: the chat's env carries the broker token and url`, rep.has_token_env && rep.has_url_env);
    check(`${name}: nothing went through the permission relay`, rep.relay_calls === 0);
    const refused = rep.calls.filter((c) => c.front !== "relay");
    check(`${name}: both fronts answered all five calls (a refusal, no card)`, refused.length === 5 && refused.every((c) => c.ok === false && c.error), JSON.stringify(refused.map((c) => [c.front, c.tool, (c.error || "").slice(0, 40)])));
  }

  // The engine saw every call, and the counter counts exactly the denials that cost Joe a row or a binding.
  const lines = fs.readFileSync(path.join(dataDir, "broker-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const mine = lines.filter((l) => kinds.some(([, sid]) => sid === l.session));
  const tally = (o) => mine.filter((l) => l.outcome === o).length;
  check("audit: 20 broker calls, 8 unbound-service, 4 unseeded-write and 8 malformed-path denials", mine.length === 20 && tally("denied_scope") === 8 && tally("denied_policy") === 4 && tally("denied_guard") === 8, JSON.stringify({ n: mine.length, scope: tally("denied_scope"), policy: tally("denied_policy"), guard: tally("denied_guard") }));
  const friction = await rpc("broker_friction", { days: 2 });
  // The window is two UTC days so a run that crosses 00:00 UTC still adds up.
  const sum = (k) => friction.days.reduce((n, d) => n + d[k], 0);
  check("broker_friction counts the scope and policy denials and lists the guard ones apart", sum("friction") === 12 && sum("guard_denials") === 8 && friction.target_per_day === 2 && friction.target_day === 7, JSON.stringify({ friction: sum("friction"), guard: sum("guard_denials"), within: friction.within_target }));
  check("broker_friction reports the first day of the log as day 1 or 2, so the day-7 target is not due yet", friction.target_due === false && friction.day_number >= 1 && friction.day_number <= 2);
  // Not reachable from the phone's door.
  let phoneFriction = null; try { phoneFriction = await phoneRpc("broker_friction", {}); } catch (e) { phoneFriction = e.message; }
  check("the phone's door refuses broker_friction by name (403, method not allowed remotely)", typeof phoneFriction === "string" && phoneFriction.includes("403") && phoneFriction.includes("not allowed remotely"), String(phoneFriction).slice(0, 80));
  check("no card of any chat went unattributed to a session", !cardsBySession.has("?"), [...(cardsBySession.get("?") || [])].join(","));
} catch (e) {
  failed = true; console.error("RIG ERROR: " + (e && e.stack || e));
  for (const f of ["daemon.err.log"]) { try { console.error(fs.readFileSync(path.join(root, f), "utf8").split("\n").slice(-25).join("\n")); } catch {} }
} finally {
  watching = false;
  try { sock.destroy(); } catch {}
  teardown();
}
const bad = results.filter((r) => !r.ok);
console.log(`\nGate 0 live run: ${results.length - bad.length}/${results.length} checks passed${failed ? ", rig error" : ""}`);
process.exit(failed || bad.length ? 1 : 0);
