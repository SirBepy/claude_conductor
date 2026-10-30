// Pins the relation between the daemon's global-WS heartbeat period and the
// SPA watchdog's stale limit. With a limit at or below the heartbeat, a healthy
// quiet socket's frame age peaks above the limit just before the next
// heartbeat lands, so the watchdog closes and redials it every cycle (a
// reconnect plus a full instances_changed snapshot each time). The two numbers
// live in different languages, so only a source-reading test can see them
// drift apart: a raised heartbeat keeps vitest, tsc and cargo test all green.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBAL_STALE_MS, GLOBAL_WATCHDOG_STALE_MS } from "../src/shared/global-stream.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pumpPath = path.join(__dirname, "..", "src-tauri", "src", "daemon", "remote_ws_pump.rs");

function heartbeatMs() {
  const src = fs.readFileSync(pumpPath, "utf8");
  const m = /const GLOBAL_HEARTBEAT_INTERVAL[^=]*=\s*std::time::Duration::from_secs\((\d+)\)/.exec(src);
  if (!m) throw new Error("GLOBAL_HEARTBEAT_INTERVAL not found in remote_ws_pump.rs; update this test's regex");
  return Number(m[1]) * 1000;
}

describe("global stream watchdog vs daemon heartbeat", () => {
  it("the steady-state watchdog limit clears the heartbeat period with slack", () => {
    expect(GLOBAL_WATCHDOG_STALE_MS).toBeGreaterThanOrEqual(heartbeatMs() + 3000);
  });

  it("the resume-path limit stays at or under the heartbeat so a thaw reconnects at once", () => {
    expect(GLOBAL_STALE_MS).toBeLessThanOrEqual(heartbeatMs());
  });
});
