import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The phone's per-chat WebSocket tells a half-open socket from a quiet healthy
// one by the daemon's 15s heartbeat (opened with `hb=1`), so it can heal itself
// without the 15s close-and-reopen the recovery heartbeat used to do.

const { HttpTransport, REMOTE_TOKEN_KEY, CHAT_STREAM_STALE_MS } = await import("../src/shared/http-transport.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");

let sockets;
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.close = vi.fn();
    this.send = vi.fn();
    sockets.push(this);
  }
}

function openSocket(ws) {
  ws.readyState = 1;
  ws.onopen();
}
const HEARTBEAT = JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: {} });

let docListeners;
let winListeners;
function fakeTarget(map) {
  return {
    addEventListener: (t, fn) => { (map[t] ??= new Set()).add(fn); },
    removeEventListener: (t, fn) => { map[t]?.delete(fn); },
  };
}
function fire(map, type) {
  for (const fn of [...(map[type] ?? [])]) fn();
}

async function listen(received) {
  return new HttpTransport().listen("chat:abc", (p) => received.push(p));
}

beforeEach(() => {
  sockets = [];
  docListeners = {};
  winListeners = {};
  globalThis.fetch = vi.fn();
  globalThis.WebSocket = MockWebSocket;
  const store = new Map([[REMOTE_TOKEN_KEY, "tok"]]);
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.location = { protocol: "https:", host: "pc:1" };
  globalThis.window = fakeTarget(winListeners);
  globalThis.document = { ...fakeTarget(docListeners), visibilityState: "visible" };
  resetTransportForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.document;
});

describe("chat stream heartbeat", () => {
  it("asks the daemon for heartbeats with hb=1", async () => {
    const un = await listen([]);
    expect(sockets[0].url).toContain("&hb=1");
    un();
  });

  it("never passes a heartbeat frame to the callback", async () => {
    const received = [];
    const un = await listen(received);
    openSocket(sockets[0]);
    sockets[0].onmessage({ data: HEARTBEAT });
    sockets[0].onmessage({ data: JSON.stringify({ type: "assistant_message" }) });
    expect(received).toEqual([{ type: "assistant_message" }]);
    un();
  });

  it("closes a heartbeating socket after 35s of silence and redials after the backoff", async () => {
    const un = await listen([]);
    openSocket(sockets[0]);
    sockets[0].onmessage({ data: HEARTBEAT });
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_STALE_MS - 1_000);
    expect(sockets[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    un();
  });

  it("a heartbeat every 15s keeps the socket", async () => {
    const un = await listen([]);
    openSocket(sockets[0]);
    for (let i = 0; i < 8; i++) {
      sockets[0].onmessage({ data: HEARTBEAT });
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(sockets[0].close).not.toHaveBeenCalled();
    un();
  });

  it("never closes a socket that has not heartbeated (older daemon), however quiet", async () => {
    const un = await listen([]);
    openSocket(sockets[0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets[0].close).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    un();
  });

  it("closes a socket stuck connecting for over 10s", async () => {
    const un = await listen([]);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sockets[0].close).not.toHaveBeenCalled();
    // The watchdog ticks every 5s, so the limit bites at the first tick past 10s.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    un();
  });

  it("delivers events_lagged on a re-open, not on the first open", async () => {
    const received = [];
    const un = await listen(received);
    openSocket(sockets[0]);
    expect(received).toEqual([]);
    sockets[0].onclose();
    await vi.advanceTimersByTimeAsync(1_000);
    openSocket(sockets[1]);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("events_lagged");
    un();
  });

  it("on return to the app a closed socket is redialled at once and a fresh healthy one is left", async () => {
    const un = await listen([]);
    openSocket(sockets[0]);
    sockets[0].onmessage({ data: HEARTBEAT });
    fire(docListeners, "visibilitychange");
    expect(sockets).toHaveLength(1);
    sockets[0].onclose();
    // The backoff retry is 1s out; resume does not wait for it.
    fire(docListeners, "visibilitychange");
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(2);
    un();
  });

  it("on return to the app a heartbeating socket past the stale limit is replaced", async () => {
    const un = await listen([]);
    openSocket(sockets[0]);
    sockets[0].onmessage({ data: HEARTBEAT });
    // The phone slept: the wall clock moved, no timer ran.
    vi.setSystemTime(Date.now() + CHAT_STREAM_STALE_MS + 1_000);
    fire(winListeners, "online");
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    un();
  });

  it("unlisten stops the watchdog, the retry and the listeners", async () => {
    const un = await listen([]);
    openSocket(sockets[0]);
    sockets[0].onclose();
    un();
    await vi.advanceTimersByTimeAsync(60_000);
    fire(docListeners, "visibilitychange");
    fire(winListeners, "online");
    expect(sockets).toHaveLength(1);
    expect(docListeners.visibilitychange?.size ?? 0).toBe(0);
    expect(winListeners.online?.size ?? 0).toBe(0);
  });
});
