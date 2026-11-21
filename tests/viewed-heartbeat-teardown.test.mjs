// @vitest-environment jsdom
// asserts: src/views/sessions/sessions-teardown.ts
// The viewed-mark heartbeat keeps the open chat awake for the daemon's idle rule. Leaving the
// Sessions view ends it, or a chat Joe left behind would never go idle while the window shows
// another view.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const seen = await import("../src/views/sessions/chat-seen.ts");
const { teardownState } = await import("../src/views/sessions/sessions-teardown.ts");

describe("viewed heartbeat and the Sessions view", () => {
  it("stops when the view is torn down", async () => {
    vi.useFakeTimers();
    try {
      const api = { mark: vi.fn(async () => 0), list: vi.fn(async () => ({})) };
      seen.setSeenApi(api);
      seen.startViewedHeartbeat(() => ["a"]);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(api.mark).toHaveBeenCalledTimes(1);

      teardownState();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(api.mark).toHaveBeenCalledTimes(1);
    } finally {
      seen.setSeenApi(null);
      vi.useRealTimers();
    }
  });
});
