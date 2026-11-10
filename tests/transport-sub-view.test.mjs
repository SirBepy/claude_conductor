// asserts: src/shared/http-transport.ts

import { describe, it, expect, beforeEach, vi } from "vitest";

// The phone transport maps the Subchats card's three daemon RPCs onto /api/rpc
// (daemon/methods/sub_view.rs). get_sub_brief once fell through into the
// list_session_images case and posted the wrong method, so each name is pinned.

const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { HttpTransport, REMOTE_TOKEN_KEY } = await import("../src/shared/http-transport.ts");

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  globalThis.fetch = fetchMock;
  const store = new Map([[REMOTE_TOKEN_KEY, "tok"]]);
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.location = { protocol: "https:", host: "pc.tail.ts.net" };
  globalThis.window = {};
  resetTransportForTests();
});

const body = () => JSON.parse(fetchMock.mock.calls[0][1].body);

describe("HttpTransport - the Subchats card RPCs", () => {
  it("posts get_sub_brief under its own name, not list_session_images", async () => {
    await new HttpTransport().call("get_sub_brief", { sessionId: "sub-1" });
    expect(body()).toEqual({ method: "get_sub_brief", params: { session_id: "sub-1" } });
  });

  it("posts list_session_images with the session id", async () => {
    await new HttpTransport().call("list_session_images", { session_id: "sub-2" });
    expect(body()).toEqual({ method: "list_session_images", params: { session_id: "sub-2" } });
  });

  it("posts set_sub_pinned with the flag", async () => {
    await new HttpTransport().call("set_sub_pinned", { sessionId: "sub-3", pinned: true });
    expect(body()).toEqual({ method: "set_sub_pinned", params: { session_id: "sub-3", pinned: true } });
  });
});
