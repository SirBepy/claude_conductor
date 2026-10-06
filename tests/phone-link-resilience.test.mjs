import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// After the phone resumes, its connection to the PC can be dead without any
// error surfacing: requests hung forever and the live stream sat in a 30s
// backoff, with nothing on screen. These pin the recovery behaviour.

const { HttpTransport, LinkError, REMOTE_TOKEN_KEY, isReadOnlyMethod } = await import("../src/shared/http-transport.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { reconnectGlobalStreamIfStale } = await import("../src/shared/global-stream.ts");
const conn = await import("../src/shared/connection-state.ts");
const { stripView } = await import("../src/shared/reconnect-strip.ts");

let sockets;
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.close = vi.fn();
    sockets.push(this);
  }
}

const fetchMock = vi.fn();

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

/** A fetch that never answers but rejects like the browser when aborted. */
function hangingFetch(_url, init) {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

beforeEach(() => {
  sockets = [];
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  globalThis.WebSocket = MockWebSocket;
  globalThis.localStorage = makeLocalStorage();
  globalThis.location = { protocol: "https:", host: "127.0.0.1:27184" };
  globalThis.window = {};
  globalThis.localStorage.setItem(REMOTE_TOKEN_KEY, "tok");
  resetTransportForTests();
  conn.resetConnectionState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rpc timeouts and retry", () => {
  it("classifies daemon reads as retryable and writes as not", () => {
    expect(isReadOnlyMethod("load_history_page")).toBe(true);
    expect(isReadOnlyMethod("list_ai_todos")).toBe(true);
    expect(isReadOnlyMethod("context_status")).toBe(true);
    expect(isReadOnlyMethod("create_worktree")).toBe(false);
    expect(isReadOnlyMethod("start_session")).toBe(false);
    expect(isReadOnlyMethod("push_commits")).toBe(false);
  });

  it("retries a read once after a network error and returns the second answer", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [1, 2] });
    const p = new HttpTransport().call("list_projects");
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a write, since the first attempt may have landed", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(new HttpTransport().call("create_worktree", { repoPath: "/r", branchName: "b" })).rejects.toBeInstanceOf(LinkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a read that gets no answer for 15s instead of hanging forever", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch);
    const p = new HttpTransport().call("list_projects");
    const settled = p.then(() => "resolved", (e) => e);
    // Both the first attempt and the retry time out.
    await vi.advanceTimersByTimeAsync(15_000 + 500 + 15_000);
    const err = await settled;
    expect(err).toBeInstanceOf(LinkError);
    expect(err.message).toMatch(/did not answer for 15s/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat an HTTP error from the PC as a dead link", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: "boom" }) });
    await expect(new HttpTransport().call("list_projects")).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(conn.linkSnapshot().kind).toBe("ok");
  });

  it("a failed request marks the link down and the next answer clears it", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(new HttpTransport().call("create_worktree", {})).rejects.toBeInstanceOf(LinkError);
    expect(conn.linkSnapshot().kind).toBe("reconnecting");
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] });
    await new HttpTransport().call("list_projects");
    expect(conn.linkSnapshot().kind).toBe("ok");
  });
});

describe("link state", () => {
  it("a stream that never came up is the boot overlay's job, not the strip's", () => {
    conn.markLiveDown(1_000);
    expect(conn.linkSnapshot(5_000).kind).toBe("ok");
  });

  it("a stream that dropped after being up reads as reconnecting, timed from the drop", () => {
    conn.markLiveUp(0);
    conn.markLiveDown(1_000);
    expect(conn.linkSnapshot(4_000)).toEqual({ kind: "reconnecting", elapsedMs: 3_000 });
    conn.markLiveUp(5_000);
    expect(conn.linkSnapshot(5_000).kind).toBe("ok");
  });

  it("a read in flight past the slow threshold is reported with its progress", async () => {
    const { LoadTracker } = await import("../src/shared/load-progress.ts");
    const tracker = new LoadTracker("load_history_page", 0);
    const done = conn.trackRequest("load_history_page", tracker, 0);
    expect(conn.linkSnapshot(conn.SLOW_REQUEST_MS - 1).kind).toBe("ok");
    const snap = conn.linkSnapshot(conn.SLOW_REQUEST_MS + 1);
    expect(snap.kind).toBe("slow");
    expect(snap.method).toBe("load_history_page");
    done();
    expect(conn.linkSnapshot(conn.SLOW_REQUEST_MS + 1).kind).toBe("ok");
  });
});

describe("strip copy", () => {
  const waiting = { phase: "waiting", fraction: null, etaMs: null, receivedBytes: 0, totalBytes: null, elapsedMs: 6_000 };

  it("hides when the link is fine", () => {
    expect(stripView({ kind: "ok" }, false)).toBeNull();
  });

  it("counts up while reconnecting, even over a loading dial", () => {
    expect(stripView({ kind: "reconnecting", elapsedMs: 4_200 }, true)?.text).toBe("Reconnecting to your PC… 4s");
  });

  it("shows a measured percentage and ETA once bytes stream in", () => {
    const load = { phase: "streaming", fraction: 0.56, etaMs: 2_000, receivedBytes: 512 * 1024, totalBytes: 1024 * 1024, elapsedMs: 5_000 };
    expect(stripView({ kind: "slow", elapsedMs: 5_000, method: "m", load }, false)?.text).toBe("Loading 56% · ~2.0s left · 512 of 1024 KB");
  });

  it("says it is waiting while no byte has arrived", () => {
    expect(stripView({ kind: "slow", elapsedMs: 6_000, method: "m", load: waiting }, false)?.text).toBe("Waiting for your PC… 6s");
  });

  it("stays out of the way of a dial already showing the same load", () => {
    expect(stripView({ kind: "slow", elapsedMs: 6_000, method: "m", load: waiting }, true)).toBeNull();
  });
});

describe("global stream on resume", () => {
  it("reconnects immediately instead of waiting out the backoff", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const unlisten = await new HttpTransport().listen("instances-changed", () => {});
    expect(sockets).toHaveLength(1);
    sockets[0].onopen();
    conn.markLiveUp();
    // The socket died while the phone slept: a backed-off retry is now pending.
    sockets[0].onclose();
    expect(sockets).toHaveLength(1);

    reconnectGlobalStreamIfStale();
    expect(sockets).toHaveLength(2);
    // The pending backoff retry was cancelled, so no third socket appears.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(2);
    unlisten();
  });

  it("dials once when resume and the network coming back land together", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const unlisten = await new HttpTransport().listen("instances-changed", () => {});
    sockets[0].onopen();
    sockets[0].onclose();
    // The phone slept: the wall clock moved on, no timer ran.
    vi.setSystemTime(Date.now() + 60_000);
    reconnectGlobalStreamIfStale();
    reconnectGlobalStreamIfStale();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].close).not.toHaveBeenCalled();
    unlisten();
  });

  it("leaves a fresh, live socket alone", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const unlisten = await new HttpTransport().listen("instances-changed", () => {});
    sockets[0].onopen();
    reconnectGlobalStreamIfStale();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].close).not.toHaveBeenCalled();
    unlisten();
  });
});
