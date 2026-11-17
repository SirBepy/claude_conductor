import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A half-dead socket stays OPEN and keeps its last chat list, so
// `streamedInstances()` used to answer `list_instances` from it with no RPC
// failure and "Waiting for your PC" never showed. A socket silent past the
// watchdog's limit is no longer trusted: the caller asks the PC instead.

const { HttpTransport, REMOTE_TOKEN_KEY } = await import("../src/shared/http-transport.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { streamedInstances, GLOBAL_WATCHDOG_STALE_MS } = await import("../src/shared/global-stream.ts");
const conn = await import("../src/shared/connection-state.ts");

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

const flush = () => new Promise((r) => setTimeout(r, 0));
let unlisten = () => {};
let now;

beforeEach(() => {
  sockets = [];
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
  globalThis.WebSocket = MockWebSocket;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.location = { protocol: "https:", host: "127.0.0.1:27184" };
  globalThis.window = {};
  globalThis.localStorage.setItem(REMOTE_TOKEN_KEY, "tok");
  resetTransportForTests();
  conn.resetConnectionState();
});

afterEach(() => {
  unlisten();
  unlisten = () => {};
  vi.restoreAllMocks();
});

describe("streamedInstances on a silent socket", () => {
  it("serves the list while frames arrive and stops serving it once the socket has been silent past the watchdog limit", async () => {
    unlisten = await new HttpTransport().listen("instances-changed", () => {});
    await flush();
    const ws = sockets[0];
    ws.readyState = 1;
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", method: "instances_changed", params: { instances: [{ session_id: "a" }] } }) });

    expect(streamedInstances()).toEqual([{ session_id: "a" }]);
    now += GLOBAL_WATCHDOG_STALE_MS;
    expect(streamedInstances()).toEqual([{ session_id: "a" }]);
    now += 1;
    expect(streamedInstances(), "OPEN but silent: not trusted").toBeNull();
  });
});
