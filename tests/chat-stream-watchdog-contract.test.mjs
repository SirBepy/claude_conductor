// Pins the relation between the daemon's heartbeat period (the per-chat stream
// reuses the global stream's 15s) and the chat socket's stale limit. A limit
// under two beats plus slack closes a healthy socket on one stalled relay hop.
// The numbers live in different languages, so only a source-reading test sees
// them drift apart.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_STREAM_STALE_MS } from "../src/shared/http-transport.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pumpPath = path.join(__dirname, "..", "src-tauri", "src", "daemon", "remote_ws_pump.rs");

function heartbeatMs() {
  const src = fs.readFileSync(pumpPath, "utf8");
  const m = /const GLOBAL_HEARTBEAT_INTERVAL[^=]*=\s*std::time::Duration::from_secs\((\d+)\)/.exec(src);
  if (!m) throw new Error("GLOBAL_HEARTBEAT_INTERVAL not found in remote_ws_pump.rs; update this test's regex");
  return Number(m[1]) * 1000;
}

describe("chat stream stale limit vs daemon heartbeat", () => {
  it("survives one missed heartbeat", () => {
    expect(CHAT_STREAM_STALE_MS).toBeGreaterThanOrEqual(heartbeatMs() * 2 + 5000);
  });
});
