// @vitest-environment jsdom

// The phone's saved usage history is one multi-MB blob, so rewriting it on
// every poll that adds a row costs a main-thread structured clone each time. Saves
// are throttled to one per minute; a hidden page, a reset and a back-fill still
// settle the saved copy at once.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));

const { loadUsageHistory, resetUsageHistoryCache, enableUsageHistoryPersistence } =
  await import("../src/shared/usage-history.ts");

const NOW = Date.parse("2026-11-07T12:00:00Z");
const MIN = 60_000;
const snap = (capturedAt, pct = 10) => ({
  captured_at: capturedAt,
  five_hour: { utilization: pct, resets_at: null },
  seven_day: { utilization: pct, resets_at: null },
  account_id: "a",
});
const minutesAgo = (m) => new Date(NOW - m * MIN).toISOString();

function memoryStore() {
  const store = {
    saved: null,
    load: vi.fn(async () => null),
    save: vi.fn(async (s) => { store.saved = s; }),
    clear: vi.fn(async () => { store.saved = null; }),
  };
  return store;
}

/** Lands one new row through the same path a `usage-updated` poll takes. */
async function pollRow(minutesBack) {
  invoke.mockResolvedValueOnce([snap(minutesAgo(minutesBack))]);
  await loadUsageHistory();
  await vi.advanceTimersByTimeAsync(0);
}

describe("throttled saves of the phone's usage history", () => {
  let store;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    invoke.mockReset();
    store = memoryStore();
    enableUsageHistoryPersistence(store);
  });
  afterEach(() => vi.useRealTimers());

  it("saves the first row at once, then holds later rows until a minute has passed", async () => {
    await pollRow(10);
    expect(store.save).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await pollRow(9);
    await vi.advanceTimersByTimeAsync(10_000);
    await pollRow(8);
    expect(store.save).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.saved.rows).toHaveLength(3);
  });

  it("saves a held row when the page is hidden", async () => {
    await pollRow(10);
    await pollRow(9);
    expect(store.save).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.saved.rows).toHaveLength(2);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("saves a held row on pagehide", async () => {
    await pollRow(10);
    await pollRow(9);

    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);

    expect(store.saved.rows).toHaveLength(2);
  });

  it("a reset cancels a held save so discarded rows are never written back", async () => {
    await pollRow(10);
    await pollRow(9);
    resetUsageHistoryCache();
    await vi.advanceTimersByTimeAsync(2 * MIN);

    expect(store.saved).toBeNull();
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("a back-fill saves at once even inside the throttle window", async () => {
    await pollRow(10);
    invoke.mockResolvedValueOnce([]); // delta
    invoke.mockResolvedValueOnce([snap(new Date(NOW - 20 * 86_400_000).toISOString())]); // older slice
    await loadUsageHistory({ fromMs: NOW - 21 * 86_400_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.saved.floor).toBe(Math.floor((NOW - 21 * 86_400_000) / 1000));
  });
});
