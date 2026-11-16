import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The PC published the whole chat list (about 190KB) on every change and the
// page then asked for the same list again, several times a second on a busy
// PC. Over the relay that filled the phone's link, every other request queued
// for 13s and more, and the page reported the link as down. The stream now
// carries one whole list per connection and then only the changed rows, and
// `list_instances` is answered from it.

const { HttpTransport, REMOTE_TOKEN_KEY } = await import("../src/shared/http-transport.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { applyInstancesDelta } = await import("../src/shared/global-stream.ts");
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

function frame(ws, method, params) {
  ws.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let unlisten = () => {};

beforeEach(() => {
  sockets = [];
  fetchMock.mockReset();
  // The list the PC would answer with, distinct from anything the stream sends.
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [{ session_id: "from-rpc" }] });
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
  unlisten();
  unlisten = () => {};
});

const listCalls = () => fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes('"list_instances"')).length;

describe("applyInstancesDelta", () => {
  it("replaces the changed rows in place and keeps the order", () => {
    const list = [{ session_id: "a", n: 1 }, { session_id: "b", n: 1 }, { session_id: "c", n: 1 }];
    expect(applyInstancesDelta(list, [{ session_id: "b", n: 2 }])).toEqual([
      { session_id: "a", n: 1 },
      { session_id: "b", n: 2 },
      { session_id: "c", n: 1 },
    ]);
  });

  it("refuses a row it has nothing to replace, so a missed snapshot is never papered over", () => {
    expect(applyInstancesDelta([{ session_id: "a" }], [{ session_id: "zzz" }])).toBeNull();
    expect(applyInstancesDelta([{ session_id: "a" }], [{ nope: 1 }])).toBeNull();
  });
});

describe("the chat list on the phone's global stream", () => {
  it("asks the daemon for changed rows only", async () => {
    unlisten = await new HttpTransport().listen("instances-changed", () => {});
    expect(sockets[0].url).toContain("delta=1");
  });

  it("answers list_instances from the stream once a snapshot arrived, without asking the PC", async () => {
    const t = new HttpTransport();
    unlisten = await t.listen("instances-changed", () => {});
    await flush();
    openSocket(sockets[0]);
    frame(sockets[0], "instances_changed", { instances: [{ session_id: "a", n: 1 }, { session_id: "b", n: 1 }] });
    const before = listCalls();

    expect(await t.call("list_instances")).toEqual([{ session_id: "a", n: 1 }, { session_id: "b", n: 1 }]);
    expect(listCalls()).toBe(before);
  });

  it("applies a delta, tells the listeners, and serves the updated list", async () => {
    const t = new HttpTransport();
    const seen = [];
    unlisten = await t.listen("instances-changed", (p) => seen.push(p));
    await flush();
    openSocket(sockets[0]);
    frame(sockets[0], "instances_changed", { instances: [{ session_id: "a", n: 1 }, { session_id: "b", n: 1 }] });
    seen.length = 0;

    frame(sockets[0], "instances_delta", { changed: [{ session_id: "b", n: 2 }] });

    expect(seen).toHaveLength(1);
    expect(await t.call("list_instances")).toEqual([{ session_id: "a", n: 1 }, { session_id: "b", n: 2 }]);
  });

  it("hands each caller its own copy", async () => {
    const t = new HttpTransport();
    unlisten = await t.listen("instances-changed", () => {});
    await flush();
    openSocket(sockets[0]);
    frame(sockets[0], "instances_changed", { instances: [{ session_id: "a", n: 1 }] });

    const first = await t.call("list_instances");
    first[0].n = 99;
    expect(await t.call("list_instances")).toEqual([{ session_id: "a", n: 1 }]);
  });

  it("asks the PC while the stream has no list: before the snapshot and after the socket closed", async () => {
    const t = new HttpTransport();
    unlisten = await t.listen("instances-changed", () => {});
    await flush();
    openSocket(sockets[0]);
    expect(await t.call("list_instances")).toEqual([{ session_id: "from-rpc" }]);

    frame(sockets[0], "instances_changed", { instances: [{ session_id: "a" }] });
    sockets[0].readyState = 3;
    sockets[0].onclose();
    expect(await t.call("list_instances")).toEqual([{ session_id: "from-rpc" }]);
  });

  it("redials for a whole list when a delta arrives with nothing to apply it to", async () => {
    unlisten = await new HttpTransport().listen("instances-changed", () => {});
    await flush();
    openSocket(sockets[0]);
    frame(sockets[0], "instances_delta", { changed: [{ session_id: "b", n: 2 }] });
    expect(sockets).toHaveLength(2);
  });
});
