import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A phone send carries one id per message so the PC delivers it once however
// often the phone tries (daemon side: remote_send_dedupe.rs). These pin the
// transport half: the id on the wire, and one automatic retry of a send whose
// answer never arrived.

const { HttpTransport, LinkError, REMOTE_TOKEN_KEY } = await import("../src/shared/http-transport.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const conn = await import("../src/shared/connection-state.ts");
const { isSessionBusyError } = await import("../src/shared/session-busy.ts");

const fetchMock = vi.fn();
const BLOCKS = [{ type: "text", text: "hello phone" }];

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

function bodyOf(call) {
  return JSON.parse(call[1].body);
}

function send(args = {}) {
  return new HttpTransport().call("send_message", { sessionId: "s1", blocks: BLOCKS, ...args });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
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

describe("report_link_journal on the phone transport", () => {
  it("posts {lines} to /api/rpc and is never retried", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) });
    await new HttpTransport().call("report_link_journal", { lines: ["a", "b"] });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/rpc");
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ method: "report_link_journal", params: { lines: ["a", "b"] } });

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(new HttpTransport().call("report_link_journal", { lines: ["a"] })).rejects.toBeInstanceOf(LinkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a request that ended in a LinkError is journalled as req_fail with its method, no payload", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(new HttpTransport().call("create_worktree", { repoPath: "/secret" })).rejects.toBeInstanceOf(LinkError);
    const j = await import("../src/shared/link-journal.ts");
    const last = j.journalEvents().at(-1);
    expect(last).toMatchObject({ k: "req_fail", d: "create_worktree fetch" });
  });
});

describe("send_message on the phone transport", () => {
  it("posts the caller's id as client_msg_id", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await send({ clientMsgId: "id-aaa" });
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ text: "hello phone", client_msg_id: "id-aaa" });
  });

  it("keeps the old body when the caller names no id", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await send();
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ text: "hello phone" });
  });

  it("retries once after a link failure, with the same id, and resolves", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const p = send({ clientMsgId: "id-bbb" });
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBe("s1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0]).client_msg_id).toBe("id-bbb");
    expect(bodyOf(fetchMock.mock.calls[1]).client_msg_id).toBe("id-bbb");
  });

  it("throws a LinkError after exactly two posts when both fail", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const settled = send({ clientMsgId: "id-ccc" }).then(() => "resolved", (e) => e);
    await vi.advanceTimersByTimeAsync(600);
    expect(await settled).toBeInstanceOf(LinkError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after the silence timeout too", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockImplementationOnce((_u, init) => new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const p = send({ clientMsgId: "id-ddd" });
    await vi.advanceTimersByTimeAsync(30_000 + 600);
    await expect(p).resolves.toBe("s1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([409, 402, 404, 500])("never retries an HTTP %i, it is the PC answering", async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, text: async () => "no" });
    await expect(send({ clientMsgId: "id-eee" })).rejects.toThrow("no");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats the dedupe 409 (first copy still being sent) as a hold-and-retry-later refusal", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => "the first copy of this message is still being sent",
    });
    const err = await send({ clientMsgId: "id-fff" }).catch((e) => e);
    expect(isSessionBusyError(err)).toBe(true);
  });
});
