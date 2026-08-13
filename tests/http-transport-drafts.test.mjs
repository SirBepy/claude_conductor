import { describe, it, expect, beforeEach, vi } from "vitest";

// The 9 cross-surface draft-sync RPCs added to HttpTransport's switch - without
// these the phone throws RemoteUnavailableError for every draft-sync call.

const { HttpTransport } = await import("../src/shared/http-transport.ts");

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  globalThis.fetch = fetchMock;
  globalThis.localStorage = makeLocalStorage();
  globalThis.location = { protocol: "https:", host: "pc.tail.ts.net" };
  globalThis.window = {};
});

function body(n = 0) {
  return JSON.parse(fetchMock.mock.calls[n][1].body);
}

describe("HttpTransport - cross-surface draft sync routing", () => {
  it("get_session_drafts", async () => {
    await new HttpTransport().call("get_session_drafts", { sessionId: "s1" });
    expect(body()).toEqual({ method: "get_session_drafts", params: { session_id: "s1" } });
  });

  it("set_composer_draft", async () => {
    await new HttpTransport().call("set_composer_draft", { sessionId: "s1", text: "hi" });
    expect(body()).toEqual({ method: "set_composer_draft", params: { session_id: "s1", text: "hi" } });
  });

  it("clear_composer_draft", async () => {
    await new HttpTransport().call("clear_composer_draft", { sessionId: "s1" });
    expect(body()).toEqual({ method: "clear_composer_draft", params: { session_id: "s1" } });
  });

  it("set_auq_draft", async () => {
    await new HttpTransport().call("set_auq_draft", { sessionId: "s1", promptId: "p1", payload: { x: 1 } });
    expect(body()).toEqual({ method: "set_auq_draft", params: { session_id: "s1", prompt_id: "p1", payload: { x: 1 } } });
  });

  it("clear_auq_draft", async () => {
    await new HttpTransport().call("clear_auq_draft", { sessionId: "s1", promptId: "p1" });
    expect(body()).toEqual({ method: "clear_auq_draft", params: { session_id: "s1", prompt_id: "p1" } });
  });

  it("add_held_message", async () => {
    const blocks = [{ type: "text", text: "held" }];
    await new HttpTransport().call("add_held_message", { sessionId: "s1", blocks });
    expect(body()).toEqual({ method: "add_held_message", params: { session_id: "s1", blocks } });
  });

  it("update_held_message", async () => {
    const blocks = [{ type: "text", text: "edited" }];
    await new HttpTransport().call("update_held_message", { sessionId: "s1", id: 3, blocks });
    expect(body()).toEqual({ method: "update_held_message", params: { session_id: "s1", id: 3, blocks } });
  });

  it("remove_held_message", async () => {
    await new HttpTransport().call("remove_held_message", { sessionId: "s1", id: 3 });
    expect(body()).toEqual({ method: "remove_held_message", params: { session_id: "s1", id: 3 } });
  });

  it("clear_held_messages", async () => {
    await new HttpTransport().call("clear_held_messages", { sessionId: "s1" });
    expect(body()).toEqual({ method: "clear_held_messages", params: { session_id: "s1" } });
  });
});
