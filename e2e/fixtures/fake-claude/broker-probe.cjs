// The broker probe of the fake `claude` (scripts/broker-gate0.mjs, plan step 8b "Gate 0").
//
// Only runs when the daemon was started with FAKE_BROKER_PROBE_DIR set and a user message holds
// BROKER_PROBE or BROKER_CONTROL. It does what a real `claude` child does around a tool call, from
// what the daemon really handed it, and writes one report file per probe:
//
//  - the argv's --allowedTools list decides whether a tool call goes through the permission relay
//    (the `approval_prompt` MCP tool, the only way the daemon raises a permission card). A tool in
//    the list skips the relay, as the real CLI does for a pre-approved tool;
//  - the broker env (CC_BROKER_TOKEN, CC_BROKER_URL) is checked for presence only. The token's
//    value is never read into the report, a log or an argument;
//  - the calls go through the real MCP child (`--mcp-config`'s cc_conductor entry) and through the
//    real loopback front (`/hooks/api-broker-http` with the token as a Bearer).
//
// The three calls stop before any secret is read or any network call is made (an unbound service, a
// path that is not a relative path, a DELETE no policy row allows), because a real daemon reads the
// user's own `~/.claude/.env` and its service hosts are pinned: a call that reached the secret read
// would send a real token to a real service.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const PREFIX = "mcp__cc_conductor__";

function mcpClient(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers.cc_conductor;
  const child = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...(cfg.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  child.stderr.resume();
  let next = 1;
  const send = (method, params, wait = true) => new Promise((resolve) => {
    const id = wait ? next++ : undefined;
    if (wait) waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    if (!wait) resolve(null);
  });
  return {
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
      await send("notifications/initialized", {}, false);
    },
    // The text a model would read, and whether the client marks it an error.
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args });
      const c = r.result && r.result.content && r.result.content[0];
      return { text: c ? c.text : JSON.stringify(r.error || r), isError: !!(r.result && r.result.isError) };
    },
    close() { try { child.stdin.end(); child.kill(); } catch {} },
  };
}

// The loopback front's own call, with the chat's token from its env. Never logs or returns the token.
function scriptCall(body) {
  return new Promise((resolve) => {
    const base = process.env.CC_BROKER_URL, token = process.env.CC_BROKER_TOKEN;
    if (!base || !token) return resolve({ status: 0, ok: false, error: "no broker env" });
    const data = JSON.stringify(body);
    const u = new URL("/hooks/api-broker-http", base);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), authorization: "Bearer " + token } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (d) => (t += d));
      res.on("end", () => { let j = {}; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, ok: j.ok === true, error: typeof j.error === "string" ? j.error.slice(0, 120) : null }); });
    });
    req.on("error", (e) => resolve({ status: 0, ok: false, error: "request failed: " + e.code }));
    req.end(data);
  });
}

async function run(argv, sid, text) {
  const pick = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const allowed = (pick("--allowedTools") || "").split(/\s+/).filter(Boolean);
  const dir = process.env.FAKE_BROKER_PROBE_DIR;
  const control = text.includes("BROKER_CONTROL");
  const report = {
    session: sid,
    mode: control ? "control" : "probe",
    allowed_api_read: allowed.includes(PREFIX + "api_read"),
    allowed_api_write: allowed.includes(PREFIX + "api_write"),
    has_token_env: !!process.env.CC_BROKER_TOKEN,
    has_url_env: !!process.env.CC_BROKER_URL,
    relay_calls: 0,
    calls: [],
  };
  const mcpPath = pick("--mcp-config");
  const mcp = mcpClient(mcpPath);
  try {
    await mcp.init();
    // What the real CLI does for a call: a tool outside --allowedTools goes to the permission relay
    // and blocks on the answer; a tool inside it runs.
    const callTool = async (name, args) => {
      if (!allowed.includes(PREFIX + name)) {
        report.relay_calls++;
        const asked = await mcp.call("approval_prompt", { tool_name: PREFIX + name, input: args });
        report.calls.push({ front: "relay", tool: name, answer: asked.text.slice(0, 80) });
        if (!/allow/.test(asked.text)) return { skipped: true };
      }
      return mcp.call(name, args);
    };
    if (control) {
      // A tool that is not pre-approved: the card this raises is what the rig must be able to see.
      await callTool("person", { action: "remember", person: "Gate Zero", alias: "G0" });
    } else {
      const reads = [
        ["api_read", { service: "shortcut", path: "/api/v3/member" }],
        ["api_read", { service: "figma", path: "https://evil.example/v1/me" }],
        ["api_write", { service: "figma", method: "DELETE", path: "/v1/files/gate0/comments/1" }],
      ];
      for (const [tool, args] of reads) {
        const r = await callTool(tool, args);
        const v = r.skipped ? {} : (() => { try { return JSON.parse(r.text); } catch { return {}; } })();
        report.calls.push({ front: "mcp", tool, ok: v.ok === true, error: typeof v.error === "string" ? v.error.slice(0, 120) : r.text.slice(0, 120) });
      }
      for (const body of [{ service: "shortcut", path: "/api/v3/member" }, { service: "figma", path: "https://evil.example/v1/me" }]) {
        report.calls.push({ front: "script", tool: "api_read", ...(await scriptCall(body)) });
      }
    }
  } finally {
    mcp.close();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}-${report.mode}.json`), JSON.stringify(report, null, 1));
  }
}

module.exports = { run };
