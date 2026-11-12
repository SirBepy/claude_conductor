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
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.close = vi.fn();
    this.send = vi.fn();
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

function openSocket(ws) {
  ws.readyState = 1;
  ws.onopen();
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
  it("a closed socket is replaced at once, with no ping, instead of waiting out the backoff", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const unlisten = await new HttpTransport().listen("instances-changed", () => {});
    expect(sockets).toHaveLength(1);
    openSocket(sockets[0]);
    conn.markLiveUp();
    // The socket died while the phone slept: a backed-off retry is now pending.
    sockets[0].onclose();
    expect(sockets).toHaveLength(1);

    sockets[0].readyState = 3;
    reconnectGlobalStreamIfStale();
    expect(sockets).toHaveLength(2);
    expect(sockets[0].send).not.toHaveBeenCalled();
    // The pending backoff retry was cancelled, so no third socket appears.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(2);
    unlisten();
  });

  it("dials once when resume and the network coming back land together", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const unlisten = await new HttpTransport().listen("instances-changed", () => {});
    openSocket(sockets[0]);
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
    openSocket(sockets[0]);
    reconnectGlobalStreamIfStale();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].close).not.toHaveBeenCalled();
    unlisten();
  });

  async function staleOpenSocket() {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const unlisten = await new HttpTransport().listen("instances-changed", () => {});
    openSocket(sockets[0]);
    // The last frame is 12s old: past the 10s resume limit, inside the 15s heartbeat gap.
    vi.setSystemTime(Date.now() + 12_000);
    return unlisten;
  }

  it("probes a stale open socket and keeps it when a frame answers inside 3s", async () => {
    const unlisten = await staleOpenSocket();
    reconnectGlobalStreamIfStale();
    expect(sockets[0].send).toHaveBeenCalledWith('{"jsonrpc":"2.0","method":"ping"}');
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[0].onmessage({ data: '{"jsonrpc":"2.0","method":"heartbeat","params":{}}' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].close).not.toHaveBeenCalled();
    expect(conn.linkSnapshot().kind).toBe("ok");
    unlisten();
  });

  it("replaces a stale open socket that stays silent for 3s after the ping", async () => {
    const unlisten = await staleOpenSocket();
    conn.markLiveUp();
    reconnectGlobalStreamIfStale();
    await vi.advanceTimersByTimeAsync(2_900);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].close).toHaveBeenCalled();
    unlisten();
  });

  it("treats a throwing send as no answer and redials at once", async () => {
    const unlisten = await staleOpenSocket();
    sockets[0].send.mockImplementation(() => { throw new Error("dying"); });
    reconnectGlobalStreamIfStale();
    expect(sockets).toHaveLength(2);
    unlisten();
  });

  it("sends one ping when resume and online land in the same tick", async () => {
    const unlisten = await staleOpenSocket();
    reconnectGlobalStreamIfStale();
    reconnectGlobalStreamIfStale();
    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(sockets).toHaveLength(2);
    unlisten();
  });
});

describe("global stream watchdog journal", () => {
  it("journals a silent socket once per outage, not on every watchdog tick", async () => {
    const journal = await import("../src/shared/link-journal.ts");
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const unlisten = await new HttpTransport().listen("instances-changed", () => {});
    openSocket(sockets[0]);
    const before = journal.journalEvents().filter((e) => e.k === "gws_stale").length;
    // A half-open socket: close() never reports back, so the watchdog fires on
    // every 5s tick for as long as the outage lasts.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sockets[0].close.mock.calls.length).toBeGreaterThan(1);
    expect(journal.journalEvents().filter((e) => e.k === "gws_stale").length - before).toBe(1);
    unlisten();
  });
});

describe("background reads", () => {
  it("a stalled background poll never reads as slow", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    void new HttpTransport().call("list_pending_prompts").catch(() => {});
    await vi.advanceTimersByTimeAsync(6_000);
    expect(conn.linkSnapshot().kind).toBe("ok");
  });

  it("a stalled read the user waits on still reads as slow", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    void new HttpTransport().call("load_history_page", {}).catch(() => {});
    await vi.advanceTimersByTimeAsync(6_000);
    expect(conn.linkSnapshot().kind).toBe("slow");
  });
});

describe("resume restarts link clocks", () => {
  it("reports the down time from the resume, not from before the page was hidden", () => {
    conn.markLiveUp(0);
    conn.markLiveDown(1_000);
    conn.noteResumed(400_000);
    expect(conn.linkSnapshot(400_500)).toEqual({ kind: "reconnecting", elapsedMs: 500 });
  });

  it("counts an in-flight read from the resume", async () => {
    const { LoadTracker } = await import("../src/shared/load-progress.ts");
    conn.trackRequest("load_history_page", new LoadTracker("load_history_page", 0), 0);
    conn.noteResumed(100_000);
    expect(conn.linkSnapshot(101_000).kind).toBe("ok");
    expect(conn.linkSnapshot(100_000 + conn.SLOW_REQUEST_MS + 1).kind).toBe("slow");
  });
});

describe("load stall clock", () => {
  it("does not fire while the link is down, and counts 8s from when it is ok again", () => {
    const stalled = conn.createStallClock(0);
    conn.markLiveUp(0);
    conn.markLiveDown(0);
    expect(stalled(10_000)).toBe(false);
    conn.markLiveUp(10_000);
    expect(stalled(10_000)).toBe(false);
    expect(stalled(17_900)).toBe(false);
    expect(stalled(18_000)).toBe(true);
  });

  it("fires after 8s of an ok link", () => {
    const stalled = conn.createStallClock(0);
    expect(stalled(7_900)).toBe(false);
    expect(stalled(8_000)).toBe(true);
  });
});
