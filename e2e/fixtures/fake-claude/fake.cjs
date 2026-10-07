// Fake `claude` CLI for the free wdio runs (CC_CLAUDE_BIN=<this dir>\claude.cmd): speaks just
// enough stream-json for the daemon. A user message containing FAKE_HANG_ON (default "HANG")
// never gets a result, so the session stays busy; one containing FAKE_SLOW_ON gets its result
// after 90s; anything else gets one text reply and a result. Each turn is also appended to the
// transcript JSONL the real CLI would write, since chat history is read from there.
// FAKE_CLAUDE_LOG=<path> appends one line per spawn, for checking what the daemon passed.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const argv = process.argv.slice(2);
const pick = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const sid = pick("--session-id") || pick("--resume") || crypto.randomUUID();
const cwd = process.cwd();
const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
const tdir = path.join(cfg, "projects", slug);
const tfile = path.join(tdir, `${sid}.jsonl`);
if (process.env.FAKE_CLAUDE_LOG) {
  try {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${new Date().toISOString()} sid=${sid} cwd=${cwd} cfg=${cfg} args=${JSON.stringify(argv).slice(0, 300)}\n`);
  } catch {}
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const tx = (o) => { try { fs.mkdirSync(tdir, { recursive: true }); fs.appendFileSync(tfile, JSON.stringify(o) + "\n"); } catch {} };
const result = (reply) => ({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sid, duration_ms: 5, duration_api_ms: 5, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, uuid: crypto.randomUUID() });
let parent = null;

// FAKE_TOOL_ROW=1: a quiet-mode turn's shape, a send_message tool_use and its
// tool_result ahead of the text reply, so the transcript holds rows the live
// stream painted differently (what the chat-resync rebuild reacts to).
function emitSendMessageRow(text) {
  const toolId = "toolu_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const tmsg = { id: "msg_" + crypto.randomUUID().replace(/-/g, ""), type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: toolId, name: "mcp__cc_conductor__send_message", input: { text } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
  const tu = crypto.randomUUID();
  out({ type: "assistant", message: tmsg, session_id: sid, uuid: tu, parent_tool_use_id: null });
  tx({ type: "assistant", message: tmsg, uuid: tu, parentUuid: parent, sessionId: sid, cwd, timestamp: new Date().toISOString() });
  parent = tu;
  const rmsg = { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: '{"message":1,"ok":true}' }] };
  const ru = crypto.randomUUID();
  out({ type: "user", message: rmsg, session_id: sid, uuid: ru, parent_tool_use_id: null });
  tx({ type: "user", message: rmsg, uuid: ru, parentUuid: parent, sessionId: sid, cwd, timestamp: new Date().toISOString() });
  parent = ru;
}

out({ type: "system", subtype: "init", cwd, session_id: sid, tools: [], mcp_servers: [], model: "claude-haiku-4-5-20251001", permissionMode: "default", uuid: crypto.randomUUID() });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("") : "");
    const uu = crypto.randomUUID();
    tx({ type: "user", message: { role: "user", content: text }, uuid: uu, parentUuid: parent, sessionId: sid, cwd, timestamp: new Date().toISOString() });
    parent = uu;
    if (text.includes(process.env.FAKE_HANG_ON || "HANG")) continue;
    const reply = "ECHO " + text.slice(0, 20);
    const mid = "msg_" + crypto.randomUUID().replace(/-/g, "");
    const amsg = { id: mid, type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    const au = crypto.randomUUID();
    setTimeout(() => {
      if (process.env.FAKE_TOOL_ROW) emitSendMessageRow(reply);
      out({ type: "assistant", message: amsg, session_id: sid, uuid: au, parent_tool_use_id: null });
      tx({ type: "assistant", message: amsg, uuid: au, parentUuid: parent, sessionId: sid, cwd, timestamp: new Date().toISOString() });
      parent = au;
      const slow = process.env.FAKE_SLOW_ON && text.includes(process.env.FAKE_SLOW_ON);
      if (slow) { setTimeout(() => out(result(reply)), 90000); return; }
      out(result(reply));
    }, 300);
  }
});
process.stdin.on("end", () => process.exit(0));
