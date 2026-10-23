import { describe, it, expect, beforeEach, vi } from "vitest";

// The phone tunnel queues past 6 concurrent requests, and boot fired the same
// read (list_pending_prompts) six times at once. Identical in-flight reads now
// share one request, unless a write went out after the read started.

const { HttpTransport } = await import("../src/shared/http-transport.ts");

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ prompts: [{ id: "p1" }] }) }));
  globalThis.fetch = fetchMock;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.location = { protocol: "https:", host: "pc.tail.ts.net" };
  globalThis.window = {};
});

const methods = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).method);

describe("HttpTransport - concurrent identical reads", () => {
  it("six simultaneous list_pending_prompts calls send one request", async () => {
    const t = new HttpTransport();
    const results = await Promise.all(Array.from({ length: 6 }, () => t.call("list_pending_prompts")));
    expect(methods()).toEqual(["list_pending_prompts"]);
    expect(results.every((r) => r.prompts[0].id === "p1")).toBe(true);
  });

  it("each caller of a shared read gets its own copy", async () => {
    const t = new HttpTransport();
    const [a, b] = await Promise.all([t.call("list_pending_prompts"), t.call("list_pending_prompts")]);
    a.prompts.push({ id: "mutated" });
    expect(b.prompts).toHaveLength(1);
  });

  it("a read issued after a write never joins a read that started before it", async () => {
    let release;
    const ok = { ok: true, json: async () => ({ prompts: [] }) };
    fetchMock.mockImplementationOnce(() => new Promise((r) => { release = () => r(ok); }));
    const t = new HttpTransport();
    const first = t.call("list_pending_prompts"); // still in flight below
    await t.call("set_auto_accept", { sessionId: "s1", enabled: true }).catch(() => {});
    const second = t.call("list_pending_prompts");
    release();
    await Promise.all([first, second]);
    expect(methods()).toEqual(["list_pending_prompts", "set_auto_accept", "list_pending_prompts"]);
  });

  it("a send over the REST route also keeps a later read off the earlier one", async () => {
    let release;
    const ok = { ok: true, json: async () => ({ prompts: [] }) };
    fetchMock.mockImplementationOnce(() => new Promise((r) => { release = () => r(ok); }));
    const t = new HttpTransport();
    const first = t.call("list_pending_prompts");
    await t.call("send_message", { sessionId: "s1", blocks: [{ type: "text", text: "hi" }] }).catch(() => {});
    const second = t.call("list_pending_prompts");
    release();
    await Promise.all([first, second]);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(["/api/rpc", "/api/sessions/s1/send", "/api/rpc"]);
  });

  it("sequential reads still each go to the network", async () => {
    const t = new HttpTransport();
    await t.call("list_pending_prompts");
    await t.call("list_pending_prompts");
    expect(methods()).toEqual(["list_pending_prompts", "list_pending_prompts"]);
  });
});
