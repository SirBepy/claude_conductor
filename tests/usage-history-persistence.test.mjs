// Pins the phone's saved usage history: a bounded recent window, kept between
// launches and validated against the PC, so a launch downloads a few KB instead
// of every stored poll (39k rows, 14.6MB on this dev's machine).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));

const { loadUsageHistory, resetUsageHistoryCache, enableUsageHistoryPersistence } =
  await import("../src/shared/usage-history.ts");

const NOW = Date.parse("2026-11-07T12:00:00Z");
const DAY = 86_400;
const unix = (iso) => Date.parse(iso) / 1000;
const iso = (ms) => new Date(ms).toISOString();
const snap = (capturedAt, pct = 10) => ({
  captured_at: capturedAt,
  five_hour: { utilization: pct, resets_at: null },
  seven_day: { utilization: pct, resets_at: null },
  account_id: "a",
});
const daysAgo = (d, extraSec = 0) => iso(NOW - d * DAY * 1000 + extraSec * 1000);

function memoryStore(initial = null) {
  const store = {
    saved: initial,
    cleared: 0,
    load: vi.fn(async () => store.saved),
    save: vi.fn(async (s) => { store.saved = s; }),
    clear: vi.fn(async () => { store.saved = null; store.cleared++; }),
  };
  return store;
}

const callsOf = (cmd) => invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("persisted usage history", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    invoke.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("a first launch downloads only the last 15 days and saves them", async () => {
    const store = memoryStore();
    enableUsageHistoryPersistence(store);
    invoke.mockResolvedValueOnce([snap(daysAgo(2)), snap(daysAgo(1))]);

    const records = await loadUsageHistory();
    await flush();

    expect(records).toHaveLength(2);
    const windowStart = NOW / 1000 - 15 * DAY;
    expect(callsOf("get_history")[0].since).toBe(windowStart);
    expect(callsOf("get_history_meta")).toHaveLength(0);
    expect(store.saved.floor).toBe(windowStart);
    expect(store.saved.cursor).toBe(unix(daysAgo(1)));
    expect(store.saved.rows).toHaveLength(2);
  });

  it("a later launch reuses the saved rows and asks only for rows from the saved cursor", async () => {
    const rows = [snap(daysAgo(3)), snap(daysAgo(1))];
    const store = memoryStore({
      rows,
      floor: NOW / 1000 - 15 * DAY,
      cursor: unix(daysAgo(1)),
    });
    enableUsageHistoryPersistence(store);
    invoke.mockImplementation(async (cmd) => (cmd === "get_history_meta" ? { count: 2 } : []));

    const records = await loadUsageHistory();

    expect(records).toHaveLength(2);
    expect(callsOf("get_history_meta")[0]).toEqual({ since: store.saved.floor, until: unix(daysAgo(1)) });
    expect(callsOf("get_history")).toEqual([{ limit: null, accountId: null, since: unix(daysAgo(1)) }]);
  });

  it("discards the saved rows when the PC counts a different number in that span", async () => {
    const store = memoryStore({
      rows: [snap(daysAgo(3)), snap(daysAgo(1))],
      floor: NOW / 1000 - 15 * DAY,
      cursor: unix(daysAgo(1)),
    });
    enableUsageHistoryPersistence(store);
    // The PC pruned one of the two rows the phone still held.
    invoke.mockImplementation(async (cmd) => (cmd === "get_history_meta" ? { count: 1 } : [snap(daysAgo(1))]));

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
    expect(callsOf("get_history")[0].since).toBe(NOW / 1000 - 15 * DAY);
  });

  it("treats a failed count check as no saved copy", async () => {
    const store = memoryStore({
      rows: [snap(daysAgo(1))],
      floor: NOW / 1000 - 15 * DAY,
      cursor: unix(daysAgo(1)),
    });
    enableUsageHistoryPersistence(store);
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "get_history_meta") throw new Error("unknown method");
      return [snap(daysAgo(1))];
    });

    await loadUsageHistory();

    expect(callsOf("get_history")[0].since).toBe(NOW / 1000 - 15 * DAY);
  });

  it("skips a saved copy older than the window instead of downloading the gap", async () => {
    const store = memoryStore({
      rows: [snap(daysAgo(40))],
      floor: NOW / 1000 - 55 * DAY,
      cursor: unix(daysAgo(40)),
    });
    enableUsageHistoryPersistence(store);
    invoke.mockResolvedValue([]);

    await loadUsageHistory();

    expect(callsOf("get_history_meta")).toHaveLength(0);
    expect(callsOf("get_history")[0].since).toBe(NOW / 1000 - 15 * DAY);
  });

  it("drops saved rows older than the window on load", async () => {
    const store = memoryStore({
      rows: [snap(daysAgo(20)), snap(daysAgo(1))],
      floor: NOW / 1000 - 25 * DAY,
      cursor: unix(daysAgo(1)),
    });
    enableUsageHistoryPersistence(store);
    invoke.mockImplementation(async (cmd) => (cmd === "get_history_meta" ? { count: 2 } : []));

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
  });

  it("fromMs older than the held days downloads that slice once and saves the lower floor", async () => {
    const store = memoryStore();
    enableUsageHistoryPersistence(store);
    invoke.mockResolvedValueOnce([snap(daysAgo(1))]);
    await loadUsageHistory();

    const windowStart = NOW / 1000 - 15 * DAY;
    const want = NOW - 21 * DAY * 1000;
    invoke.mockResolvedValueOnce([snap(daysAgo(20)), snap(daysAgo(16))]);
    const records = await loadUsageHistory({ fromMs: want });
    await flush();

    const back = callsOf("get_history").find((c) => c.until != null);
    expect(back).toEqual({ limit: null, accountId: null, since: want / 1000, until: windowStart });
    expect(records).toHaveLength(3);
    expect(store.saved.floor).toBe(want / 1000);

    // The same ask again, and a nearer one, cost nothing more.
    invoke.mockClear();
    invoke.mockResolvedValue([]);
    await loadUsageHistory({ fromMs: want });
    await loadUsageHistory({ fromMs: NOW - 18 * DAY * 1000 });
    expect(callsOf("get_history").filter((c) => c.until != null)).toHaveLength(0);
  });

  it("fromMs inside the held days downloads nothing extra", async () => {
    enableUsageHistoryPersistence(memoryStore());
    invoke.mockResolvedValue([snap(daysAgo(1))]);
    await loadUsageHistory();
    invoke.mockClear();
    invoke.mockResolvedValue([]);

    await loadUsageHistory({ fromMs: NOW - 10 * DAY * 1000 });

    expect(callsOf("get_history").filter((c) => c.until != null)).toHaveLength(0);
  });

  it("four widgets asking for the same older slice share one download", async () => {
    enableUsageHistoryPersistence(memoryStore());
    invoke.mockResolvedValue([snap(daysAgo(1))]);
    await loadUsageHistory();
    invoke.mockClear();
    invoke.mockImplementation(async (_cmd, args) => (args.until != null ? [snap(daysAgo(20))] : []));

    const want = NOW - 21 * DAY * 1000;
    await Promise.all([1, 2, 3, 4].map(() => loadUsageHistory({ fromMs: want })));

    expect(callsOf("get_history").filter((c) => c.until != null)).toHaveLength(1);
  });

  it("a reset clears the saved copy so the next launch cannot load discarded rows", async () => {
    const store = memoryStore();
    enableUsageHistoryPersistence(store);
    invoke.mockResolvedValue([snap(daysAgo(1))]);
    await loadUsageHistory();
    await flush();
    expect(store.saved).not.toBeNull();

    resetUsageHistoryCache();
    await flush();

    expect(store.saved).toBeNull();
  });
});
