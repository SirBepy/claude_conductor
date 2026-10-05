// Pins the incremental usage-history cache that replaced a full re-download
// of every stored poll (48k rows here) on each usage-updated listener.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));

const { loadUsageHistory, resetUsageHistoryCache } = await import("../src/shared/usage-history.ts");

const snap = (capturedAt, accountId, pct = 10) => ({
  captured_at: capturedAt,
  five_hour: { utilization: pct, resets_at: null },
  seven_day: { utilization: pct, resets_at: null },
  account_id: accountId,
});

const sinceOf = (call) => call[1].since;

describe("loadUsageHistory", () => {
  beforeEach(() => {
    resetUsageHistoryCache();
    invoke.mockReset();
  });

  it("fetches everything once, then only from the newest cached second", async () => {
    invoke.mockResolvedValueOnce([
      snap("2026-07-01T00:00:00Z", "a"),
      snap("2026-07-01T00:01:00Z", "a"),
    ]);
    await loadUsageHistory();
    expect(sinceOf(invoke.mock.calls[0])).toBeNull();

    invoke.mockResolvedValueOnce([]);
    await loadUsageHistory();
    expect(sinceOf(invoke.mock.calls[1])).toBe(Date.parse("2026-07-01T00:01:00Z") / 1000);
  });

  it("drops the cursor-second rows the inclusive re-read sends back, keeps new ones", async () => {
    invoke.mockResolvedValueOnce([snap("2026-07-01T00:01:00Z", "a", 1)]);
    await loadUsageHistory();

    // Same second: the already-held row plus another account's row that
    // landed in that second after the first read.
    invoke.mockResolvedValueOnce([
      snap("2026-07-01T00:01:00Z", "a", 1),
      snap("2026-07-01T00:01:00Z", "b", 2),
      snap("2026-07-01T00:02:00Z", "a", 3),
    ]);
    const all = await loadUsageHistory();
    expect(all.map((r) => r.session_pct)).toEqual([1, 2, 3]);
  });

  it("scopes to one account client-side and honours limit", async () => {
    invoke.mockResolvedValueOnce([
      snap("2026-07-01T00:00:00Z", "a", 1),
      snap("2026-07-01T00:01:00Z", "b", 2),
      snap("2026-07-01T00:02:00Z", "a", 3),
    ]);
    const onlyA = await loadUsageHistory({ accountId: "a" });
    expect(onlyA.map((r) => r.session_pct)).toEqual([1, 3]);

    invoke.mockResolvedValueOnce([]);
    const newest = await loadUsageHistory({ limit: 1 });
    expect(newest.map((r) => r.session_pct)).toEqual([3]);
  });

  it("coalesces a burst of callers into the running fetch plus one follow-up", async () => {
    let release;
    invoke.mockImplementationOnce(() => new Promise((r) => { release = () => r([]); }));
    invoke.mockResolvedValue([]);
    const burst = [loadUsageHistory(), loadUsageHistory(), loadUsageHistory(), loadUsageHistory()];
    release();
    await Promise.all(burst);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("refetches everything after a reset", async () => {
    invoke.mockResolvedValueOnce([snap("2026-07-01T00:00:00Z", "a")]);
    await loadUsageHistory();
    resetUsageHistoryCache();
    invoke.mockResolvedValueOnce([]);
    expect(await loadUsageHistory()).toEqual([]);
    expect(sinceOf(invoke.mock.calls[1])).toBeNull();
  });
});
