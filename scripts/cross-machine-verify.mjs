#!/usr/bin/env node
// Live two-instance run of cross-machine subchats (docs/cross-machine-subchats.md, step 8).
//
// Two real daemon processes on this PC, each with its own data folder, instance label and
// ports, paired by a direct http://127.0.0.1:<port> URL, so neither touches the production
// daemon on 27183. A main chat on daemon A (the home) spawns a sub on daemon B (the host),
// which runs a fake `claude` (e2e/fixtures/fake-claude/claude.exe), so no model is billed: this
// script plays the sub itself through the same hook routes the real MCP tools post to.
//
//   node scripts/cross-machine-verify.mjs --exe <cc-conductor-daemon.exe> [--keep]
//
// Never builds anything: build the daemon first (cargo build --bin cc-conductor-daemon) and the
// fake claude (scripts/build-fake-claude.ps1). Tears down by PID only.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const exe = arg("--exe") ?? path.join(repoRoot, "..", "..", "target", "debug", "cc-conductor-daemon.exe");
const fakeClaude = arg("--fake-claude") ?? path.join(repoRoot, "e2e", "fixtures", "fake-claude", "claude.exe");
const keep = args.includes("--keep");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 30_000, every = 300) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "user.email=xm@local", "-c", "user.name=xm", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};

for (const f of [exe, fakeClaude]) if (!fs.existsSync(f)) throw new Error(`missing ${f}: build it first, this script never does`);

// ---- scratch: a bare origin, two clones of it (one per machine) ----------------------------
const scratchParent = fs.existsSync("D:\\cargo-target") ? "D:\\cargo-target" : os.tmpdir();
const scratch = path.join(scratchParent, `xm-verify-${crypto.randomBytes(4).toString("hex")}`);
const origin = path.join(scratch, "origin.git");
fs.mkdirSync(scratch, { recursive: true });
git(scratch, "init", "-q", "--bare", "-b", "main", origin);
const seed = path.join(scratch, "seed");
git(scratch, "clone", "-q", origin, seed);
fs.writeFileSync(path.join(seed, "README.md"), "# xm scratch\n");
git(seed, "add", "-A");
git(seed, "commit", "-q", "-m", "seed");
git(seed, "push", "-q", "origin", "HEAD:main");
const homeRepo = path.join(scratch, "home-proj");
const hostRepo = path.join(scratch, "host-proj");
git(scratch, "clone", "-q", origin, homeRepo);
git(scratch, "clone", "-q", origin, hostRepo);

// ---- two daemons ---------------------------------------------------------------------------
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function makeNode(tag, repo, extraEnv = {}) {
  const dataDir = path.join(scratch, `${tag}-data`);
  fs.mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const acct = crypto.randomUUID();
  fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify([{
    id: acct, label: `xm-${tag}`, colour: "", icon: "", config_dir: path.join(dataDir, "claude-config"),
    chrome_profile_dir: path.join(dataDir, "chrome-profile"), email: `xm-${tag}@example.com`, org_uuid: crypto.randomUUID(),
    subscription_tier: "", created_at: now, fleet_eligible: false,
  }]));
  // The drift guard wants a logged-in profile before it spawns anything: a dummy login the fake claude never reads.
  fs.mkdirSync(path.join(dataDir, "claude-config"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "claude-config", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "dummy-access-not-a-real-token", refreshToken: "dummy-refresh-not-a-real-token", expiresAt: Date.now() + 3.15e10, refreshTokenExpiresAt: Date.now() + 6.3e10 },
  }));
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    projects: [{ id: crypto.randomUUID(), path: repo, name: "xm-proj", created_at: now }],
    default_account_id: acct,
  }));
  fs.writeFileSync(path.join(dataDir, "remote-devices.json"), '{"devices":[],"enabled":true,"schema":1}');
  return { tag, repo, dataDir, label: `xm-${tag}`, extraEnv, proc: null, port: 0, log: path.join(scratch, `${tag}.log`) };
}

async function start(node) {
  node.port = node.port || await freePort();
  const out = fs.openSync(node.log, "a");
  node.proc = spawn(exe, [], {
    env: {
      ...process.env, CC_DATA_DIR: node.dataDir, CC_DAEMON_INSTANCE: node.label, CC_REMOTE_PORT: String(node.port),
      CC_DAEMON_NO_AUTOSTART: "1", ...node.extraEnv,
    },
    stdio: ["ignore", out, out], windowsHide: true,
  });
  await until(`${node.tag} remote-access token`, () => fs.existsSync(path.join(node.dataDir, "remote-access.json")) && fs.readFileSync(path.join(node.dataDir, "remote-access.json"), "utf8").length > 0, 60_000);
  await until(`${node.tag} http`, async () => { try { return (await fetch(`http://127.0.0.1:${node.port}/`)).status < 500; } catch { return false; } }, 60_000);
  const portFile = path.join(node.dataDir, `hooks_port-${node.label}.txt`);
  node.hooksPort = Number(await until(`${node.tag} hooks port`, () => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").trim(), 30_000));
}

function stop(node) {
  if (node.proc?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(node.proc.pid)]);
  node.proc = null;
}

// The daemon's named pipe: 4-byte big-endian length frames, a handshake frame first.
function pipeName(node) { return `\\\\.\\pipe\\cc-conductor-daemon-${os.userInfo().username}-${node.label}`; }
async function rpc(node, method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipeName(node));
    let buf = Buffer.alloc(0);
    const send = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); sock.write(Buffer.concat([h, b])); };
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`rpc ${method} timed out`)); }, 60_000);
    sock.on("connect", () => { send({ protocol_version: 1 }); send({ jsonrpc: "2.0", id: 1, method, params }); });
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        const msg = JSON.parse(buf.subarray(4, 4 + n).toString());
        buf = buf.subarray(4 + n);
        if (msg.id === 1) { clearTimeout(timer); sock.destroy(); return msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result); }
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function hook(node, route, body) {
  const r = await fetch(`http://127.0.0.1:${node.hooksPort}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { status: r.status, text }; }
}

const home = makeNode("a", homeRepo);
const host = makeNode("b", hostRepo, { CC_CLAUDE_BIN: fakeClaude });
let failed = false;

async function main() {
  console.log(`scratch: ${scratch}`);
  await start(home);
  await start(host);
  check("two daemons up on their own ports", home.port !== host.port, `a=${home.port} b=${host.port}`);

  // Both daemons run on this PC, so they share a hostname: a `machine` named by that label would be "this
  // machine". Give each its own name first, as two real machines would have.
  await rpc(home, "set_machine_profile", { label: "Home PC" });
  await rpc(host, "set_machine_profile", { label: "Mac mini" });

  // Pair: the home writes a pairing code the way the app does; the host pastes its link.
  const code = "xm-pair-code";
  fs.writeFileSync(path.join(home.dataDir, "remote-pairing.json"), JSON.stringify({
    code_hash: crypto.createHash("sha256").update(code).digest("hex"), expires_at: Math.floor(Date.now() / 1000) + 600,
  }));
  await rpc(host, "pair_machine", { url: `http://127.0.0.1:${home.port}/?pair=${code}`, my_url: `http://127.0.0.1:${host.port}` });
  const machinesA = await until("A lists B online", async () => { const m = await rpc(home, "list_machines"); return m.peers?.length ? m : null; });
  const hostLabel = machinesA.peers[0].label;
  check("the two machines are paired", machinesA.peers.length === 1, `B is "${hostLabel}" to A`);

  await scenario(hostLabel);
}

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const cardsOf = (node, main) => {
  try { return fs.readFileSync(path.join(node.dataDir, "subchats", `${main}.cards.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const instance = async (node, id) => (await rpc(node, "list_instances")).find((i) => i.session_id === id);

async function scenario(hostLabel) {
  const tag = crypto.randomBytes(3).toString("hex");
  const MAIN = `xm-main-${tag}`;

  // A main chat on the home: a registered chat with Use subchats on.
  await hook(home, "/hooks/session-start", { session_id: MAIN, cwd: homeRepo, pid: process.pid, source: "startup" });
  await rpc(home, "set_subchats_on", { session_id: MAIN, value: true });

  // 1. Spawn a writing sub on the host.
  const spawned = await hook(home, "/chat/spawn", {
    session_id: MAIN, cwd: homeRepo, machine: hostLabel, name: "notes", task: "Add notes.txt", goal: "A notes file exists",
    done_when: "notes.txt is committed", writes: true, files: ["notes.txt"], model: "sonnet", effort: "medium", report_back: true,
  });
  check("spawn_chat with machine starts a sub on the host", spawned.ok === true && !!spawned.session_id, JSON.stringify(spawned).slice(0, 200));
  const SUB = spawned.session_id;
  const hostRow = await until("the sub's row on the host", () => instance(host, SUB));
  check("the host registered it as a sub of the home's main chat", hostRow.subchat_of === MAIN, `cwd=${hostRow.cwd}`);
  const mirrored = await until("the mirrored row on the home", async () => { const r = await instance(home, SUB); return r?.machine ? r : null; });
  check("the home lists it as its own sub, stamped with the host's machine", mirrored.subchat_of === MAIN && mirrored.machine.label === hostLabel, `machine=${mirrored.machine.label}`);
  const records = readJson(path.join(home.dataDir, "subchats", "remote-subs-xm-a.json"), null);
  check("the home recorded the remote sub", JSON.stringify(records ?? {}).includes(SUB));

  // 2. A question the sub asks shows on the home, answered there.
  const qid = `q-${tag}`;
  const asked = hook(host, "/questions/request", { id: qid, session_id: SUB, questions: [{ question: "Which name?", header: "Name", multiSelect: false, options: [{ label: "notes" }, { label: "memo" }] }] });
  const card = await until("the question card on the home", async () => (await rpc(home, "list_pending_prompts")).find((p) => p.id === qid));
  check("the sub's question shows in the home, in the main chat's window", card.payload.display_session_id === MAIN && card.payload.session_id === SUB);
  await rpc(home, "respond_question", { request_id: qid, session_id: SUB, answers: { "Which name?": "notes" } });
  await until("the card to leave the host", async () => !(await rpc(host, "list_pending_prompts")).some((p) => p.id === qid), 20_000);
  // What the answer itself said is not checked here: the hook answers only a shown-ack.
  check("the answered card is gone from the host's pending list", !(await rpc(host, "list_pending_prompts")).some((p) => p.id === qid));
  await asked.catch(() => null);
  const homeLog = path.join(home.dataDir, "subchats", `${MAIN}.decisions.md`);
  check("Joe's answer is in the home's decisions log, word for word", fs.existsSync(homeLog) && /Question: Which name\?\s+Answer: notes/.test(fs.readFileSync(homeLog, "utf8")));
  check("and the host wrote no decisions log for the home's chat", !fs.existsSync(path.join(host.dataDir, "subchats", `${MAIN}.decisions.md`)));

  // 3. Its answer card is drawn on the home with the machine on it.
  await hook(host, "/messages/send", { session_id: SUB, kind: "answer", verdict: "Chosen", text: "notes it is", question: "Which name?" });
  const answerCard = await until("the answer card on the home", () => cardsOf(home, MAIN).find((c) => c.kind === "answer"));
  check("a visiting sub's answer card is drawn on the home, naming the machine", answerCard.machine === hostLabel && answerCard.sub_id === SUB, `machine=${answerCard.machine}`);
  check("and no card log was written on the host", cardsOf(host, MAIN).length === 0);

  // 4. A secret over the plain http link is refused.
  const secret = await hook(host, "/secrets/request", { id: `s-${tag}`, label: "Token", file: ".env", key: "TOKEN", session_id: SUB });
  check("a secret request over the http link is refused with the by-hand note", secret.ok === false && /by hand/.test(JSON.stringify(secret)), JSON.stringify(secret).slice(0, 160));

  // 5. The sub commits in its tree; the home is stopped so its finish waits in the host's outbox.
  const tree = hostRow.cwd;
  fs.writeFileSync(path.join(tree, "notes.txt"), "hello from the host\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "add notes.txt");
  stop(home);
  const fin = await hook(host, "/subchats/finish", { session_id: SUB, verdict: "Built", text: "notes.txt added", decided: ["nothing"], ruled_out: ["nothing"], learned: ["nothing"] });
  check("finish_subchat is accepted on the host", fin.ok === true, JSON.stringify(fin).slice(0, 200));
  await rpc(host, "send_message", { session_id: SUB, text: "continue" }).catch(() => null); // a turn end commits the finish
  const outboxFile = path.join(host.dataDir, "subchats", "outbox-xm-b.json");
  const queued = await until("a queued event in the host's outbox", () => (JSON.stringify(readJson(outboxFile, {})).includes("finished") ? true : null), 60_000);
  check("with the home down, a finished event is queued in the host's outbox", queued === true && JSON.stringify(readJson(outboxFile, {})).includes("finished"));

  // 6. The home comes back; the outbox is delivered, the commit lands in its checkout, the card says where it ran.
  await start(home);
  const finishCard = await until("the finish card on the home", () => cardsOf(home, MAIN).find((c) => c.kind === "finish"), 120_000, 1000);
  check("after the home restarts the queued finish arrives and draws its card", finishCard.sub_id === SUB && finishCard.machine === hostLabel, `machine=${finishCard.machine}`);
  const landed = await until("the commit in the home checkout", () => fs.existsSync(path.join(homeRepo, "notes.txt")), 60_000).catch(() => false);
  check("the sub's commit was merged into the home's checkout", !!landed && git(homeRepo, "log", "--oneline").includes("add notes.txt"));
  check("the finish card says the commits landed", finishCard.facts?.merged === true, JSON.stringify(finishCard.facts?.merged));
}

try {
  await main();
} catch (e) {
  failed = true;
  console.error(`ERROR  ${e.stack ?? e}`);
} finally {
  if (!keep) { stop(home); stop(host); await sleep(800); try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a handle is still closing */ } }
  else console.log(`kept: ${scratch} (a: ${home.proc?.pid}, b: ${host.proc?.pid})`);
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed${failed ? ", run aborted with an error" : ""}`);
process.exit(bad.length || failed ? 1 : 0);
