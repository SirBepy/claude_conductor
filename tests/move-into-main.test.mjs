// @vitest-environment jsdom
// "Move into main chat": which chats the picker offers, the menu item's gating, and
// the phone transport case.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mainChatCandidates } from "../src/views/sessions/move-into-main.ts";
import { buildChatItems } from "../src/views/sessions/chat-menu-items.ts";

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "/p/cv", project_id: "p", kind: "interactive", is_remote: false,
  started_at: "2026-11-05T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});

describe("mainChatCandidates", () => {
  const on = new Set(["a", "b", "sub", "gone", "peer", "self"]);
  const rows = [
    inst({ session_id: "self" }),
    inst({ session_id: "a" }),
    inst({ session_id: "b" }),
    inst({ session_id: "off" }),
    inst({ session_id: "sub", subchat_of: "a" }),
    inst({ session_id: "gone", ended_at: "2026-11-05T11:00:00Z" }),
    inst({ session_id: "peer", machine: { id: "m2", label: "Studio", online: true } }),
  ];

  it("offers live main chats only: not itself, a sub, an ended chat, a mirrored one or one with the mode off", () => {
    expect(mainChatCandidates(rows, "self", (id) => on.has(id)).map((s) => s.session_id)).toEqual(["a", "b"]);
  });

  it("puts the chat's previous main chat first", () => {
    expect(mainChatCandidates(rows, "self", (id) => on.has(id), "b").map((s) => s.session_id)).toEqual(["b", "a"]);
  });

  it("ignores a previous main chat that no longer qualifies", () => {
    expect(mainChatCandidates(rows, "self", (id) => on.has(id), "off").map((s) => s.session_id)).toEqual(["a", "b"]);
  });
});

describe("the chat menu item", () => {
  const ctx = (over = {}) => ({
    kind: "live", sessionId: "c", cwd: "/p", pid: 1, readOnly: false, autoAcceptOn: false,
    subchatsOn: false, isHidden: false, ...over,
  });
  const item = (label, over) => buildChatItems(ctx(over)).find((i) => i.label === label);

  it("offers Move into main chat on an ordinary chat and Move to sidebar on a sub, never both", () => {
    expect(item("Move into main chat", {})?.run).toBeTypeOf("function");
    expect(item("Move to sidebar", {})).toBeUndefined();
    expect(item("Move to sidebar", { isSub: true })?.run).toBeTypeOf("function");
    expect(item("Move into main chat", { isSub: true })).toBeUndefined();
  });

  it("disables it, with the reason, for a main chat, a mirrored chat and a draft", () => {
    expect(item("Move into main chat", { subchatsOn: true })).toMatchObject({ run: undefined, disabledReason: expect.stringContaining("main chat cannot be a sub") });
    expect(item("Move into main chat", { mirrored: true })?.run).toBeUndefined();
    expect(item("Move into main chat", { kind: "draft", sessionId: null })?.run).toBeUndefined();
  });
});

describe("HttpTransport - move_chat_into_main", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = fetchMock;
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    globalThis.location = { protocol: "https:", host: "pc.tail.ts.net" };
  });

  it("reaches the daemon RPC with snake_case params", async () => {
    const { HttpTransport } = await import("../src/shared/http-transport.ts");
    await new HttpTransport().call("move_chat_into_main", { sessionId: "c", mainId: "m" });
    await new HttpTransport().call("former_main_chat", { sessionId: "c" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      method: "move_chat_into_main",
      params: { session_id: "c", main_id: "m" },
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      method: "former_main_chat",
      params: { session_id: "c" },
    });
  });
});
