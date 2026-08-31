// @vitest-environment jsdom
//
// Pins the windowing that replaced an unbounded fetch which had reached 100MB.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getTokenHistory, getActiveSessions } = vi.hoisted(() => ({
  getTokenHistory: vi.fn(),
  getActiveSessions: vi.fn(),
}));

vi.mock("../src/shared/api.ts", () => ({
  api: {
    getTokenHistory: (...a) => getTokenHistory(...a),
    getActiveSessions: (...a) => getActiveSessions(...a),
  },
}));

const { loadTokenHistory, windowSince, resetTokenHistoryWindow, mergeLiveSessions } =
  await import("../src/shared/token-history.ts");
const { setTokenHistory } = await import("../src/shared/state.ts");

const record = (id) => ({ sessionId: id, date: "2026-08-30", inputTokens: 1 });

describe("loadTokenHistory", () => {
  beforeEach(() => {
    resetTokenHistoryWindow();
    setTokenHistory(null);
    getTokenHistory.mockReset().mockResolvedValue([record("s1")]);
    getActiveSessions.mockReset().mockResolvedValue([]);
  });

  it("asks the store for a bounded window, not all history", async () => {
    await loadTokenHistory(30);
    const since = getTokenHistory.mock.calls[0][0];
    expect(since).toBeGreaterThan(0);
    // Unix SECONDS: passing ms would ask for a ~50,000-year window.
    expect(Math.abs(since - windowSince(30))).toBeLessThanOrEqual(1);
  });

  it("asks for all history when days is 0", async () => {
    await loadTokenHistory(0);
    expect(getTokenHistory).toHaveBeenCalledWith(0);
  });

  it("does not refetch when a narrower window is requested than one already loaded", async () => {
    await loadTokenHistory(90);
    expect(getTokenHistory).toHaveBeenCalledTimes(1);
    await loadTokenHistory(7);
    expect(getTokenHistory).toHaveBeenCalledTimes(1);
  });

  it("refetches when a WIDER window is requested", async () => {
    await loadTokenHistory(7);
    expect(getTokenHistory).toHaveBeenCalledTimes(1);
    await loadTokenHistory(0);
    expect(getTokenHistory).toHaveBeenCalledTimes(2);
  });

  it("appends live sessions to the persisted rows", async () => {
    getActiveSessions.mockResolvedValue([record("live-1")]);
    const out = await loadTokenHistory(30);
    expect(out.map((r) => r.sessionId)).toEqual(["s1", "live-1"]);
  });

  it("still resolves with the persisted rows when the live lookup throws", async () => {
    getActiveSessions.mockRejectedValue(new Error("not registered yet"));
    const out = await loadTokenHistory(30);
    expect(out.map((r) => r.sessionId)).toEqual(["s1"]);
  });
});

describe("mergeLiveSessions", () => {
  it("tolerates a null history payload", () => {
    expect(mergeLiveSessions(null, [record("live")])).toEqual([record("live")]);
    expect(mergeLiveSessions(null, [])).toEqual([]);
  });
});
