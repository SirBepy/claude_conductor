// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A read whose reply never arrives must not poison its cache entry: before the
// stale-inflight timeout, every later read of that entry awaited the same dead
// promise, so clicking the project in the New chat picker did nothing for the
// rest of the app session.

vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
const invoke = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));
vi.mock("../src/shared/api.ts", () => ({ api: {} }));

const cache = await import("../src/views/sessions/new-session-cache.ts");

beforeEach(() => {
  vi.useFakeTimers();
  cache.resetNewSessionCacheForTests();
  invoke.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("new-session cache with a lost reply", () => {
  it("rejects a read that never settles, then refetches on the next read", async () => {
    invoke.mockImplementationOnce(() => new Promise(() => {}));
    const first = cache.claudeMdScopesData("C:\\p\\one");
    const settled = expect(first.ready).rejects.toThrow("read timed out");
    await vi.advanceTimersByTimeAsync(cache.INFLIGHT_STALE_MS + 1);
    await settled;

    const scopes = [{ rel_path: "", abs_path: "C:\\p\\one", label: "Repo root", nested: false }];
    invoke.mockImplementationOnce(() => Promise.resolve(scopes));
    const second = cache.claudeMdScopesData("C:\\p\\one");
    await expect(second.ready).resolves.toEqual(scopes);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("still dedupes concurrent reads while a fetch is merely slow", async () => {
    invoke.mockImplementation(() => new Promise((r) => setTimeout(() => r([]), 1000)));
    const a = cache.claudeMdScopesData("C:\\p\\one");
    const b = cache.claudeMdScopesData("C:\\p\\one");
    await vi.advanceTimersByTimeAsync(1001);
    await Promise.all([a.ready, b.ready]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
