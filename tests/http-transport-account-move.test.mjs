import { describe, it, expect, beforeEach, vi } from "vitest";

// The account chip's move-to-account call had no HttpTransport case, so on the
// phone it threw RemoteUnavailableError and the chip only ever toasted a failure.

const { HttpTransport } = await import("../src/shared/http-transport.ts");

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ session_id: "s1" }) });
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

describe("HttpTransport - move_session_to_account", () => {
  it("sends snake_case params and returns the bare session id like the Tauri command", async () => {
    const id = await new HttpTransport().call("move_session_to_account", { sessionId: "s1", targetAccountId: "acc-b" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      method: "move_session_to_account",
      params: { session_id: "s1", target_account_id: "acc-b" },
    });
    expect(id).toBe("s1");
  });
});
