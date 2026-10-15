// @vitest-environment jsdom
//
// bulkLoadEvents yields to the event loop by elapsed work, not per 8-event
// chunk: each nested setTimeout(0) clamps to 4ms, which idled ~430ms of a
// measured 1.2s chat open (2026-10-15).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { userEvent, finalEvent } from "./helpers/chat-events.mjs";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

function events(n) {
  const out = [];
  for (let i = 0; i < n / 2; i++) {
    out.push(userEvent(`u${i}`, i * 2));
    out.push(finalEvent(`a${i}`, i * 2 + 1));
  }
  return out;
}

/** setTimeout(…, 0) calls made while `fn` runs - the bulk-load yields. */
async function countZeroTimeouts(fn) {
  const real = globalThis.setTimeout;
  let n = 0;
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((cb, ms, ...rest) => {
    if (!ms) n++;
    return real(cb, ms, ...rest);
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return n;
}

let nowSpy = null;
beforeEach(() => {
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
});
afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
});

describe("bulkLoadEvents yield budget", () => {
  it("does not yield between chunks while the work stays under budget", async () => {
    // Frozen clock: no chunk ever exceeds the budget.
    nowSpy = vi.spyOn(performance, "now").mockReturnValue(1000);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    const yields = await countZeroTimeouts(() => r.loadHistory(events(80)));

    // 80 events = 10 chunks; the per-chunk yield made 9 of these.
    expect(yields).toBeLessThan(3);
    expect(r.messages.length).toBe(80);
  });

  it("still yields once a chunk run passes the budget", async () => {
    let t = 0;
    nowSpy = vi.spyOn(performance, "now").mockImplementation(() => (t += 20));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    const yields = await countZeroTimeouts(() => r.loadHistory(events(80)));

    expect(yields).toBeGreaterThanOrEqual(9);
    expect(r.messages.length).toBe(80);
  });
});
