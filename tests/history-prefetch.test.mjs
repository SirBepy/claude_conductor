// @vitest-environment jsdom

// asserts: src/shared/chat/history-prefetch.ts
// The phone warms history-page-cache for the chats it is most likely to open next.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));

const { pickPrefetchTargets, prefetchRecentChats, holdPrefetch } = await import("../src/shared/chat/history-prefetch.ts");
const { loadCachedPage } = await import("../src/shared/chat/history-page-cache.ts");

const row = (id, over = {}) => ({ session_id: id, cwd: "/p", kind: "chat", started_at: "2026-11-24T10:00:00Z", ended_at: null, busy: false, awaiting: null, ...over });
const page = (text) => ({
  events: [{ type: "user_message", content: [{ type: "text", text }], timestamp: 1 }],
  oldest_seq: 1,
  has_more: false,
  continues_from: null,
});

beforeEach(() => {
  delete window.__TAURI__;
  localStorage.clear();
  invoke.mockReset();
  holdPrefetch(false);
});

describe("pickPrefetchTargets", () => {
  it("puts a chat waiting on an answer first, then a busy one, then the newest", () => {
    const list = [
      row("old", { started_at: "2026-11-20T10:00:00Z" }),
      row("new", { started_at: "2026-11-24T10:00:00Z" }),
      row("busy", { busy: true }),
      row("ask", { awaiting: "question" }),
    ];
    expect(pickPrefetchTargets(list, () => false).map((i) => i.session_id)).toEqual(["ask", "busy", "new", "old"]);
  });

  it("skips ended, external and already cached chats", () => {
    const list = [row("a"), row("b", { ended_at: "x" }), row("c", { kind: "external" }), row("d")];
    expect(pickPrefetchTargets(list, (id) => id === "d").map((i) => i.session_id)).toEqual(["a"]);
  });
});

describe("prefetchRecentChats", () => {
  it("stores each fetched page, asking for the phone's small first page in the background", async () => {
    invoke.mockResolvedValue(page("hello"));
    await prefetchRecentChats([row("p1")]);
    expect(invoke).toHaveBeenCalledWith("load_history_page", { sessionId: "p1", messageLimit: 5, cwd: "/p" }, { background: true });
    expect(loadCachedPage("p1")?.events).toHaveLength(1);
  });

  it("does nothing while a chat open holds the tunnel", async () => {
    holdPrefetch(true);
    await prefetchRecentChats([row("p2")]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does nothing on the desktop", async () => {
    window.__TAURI__ = {};
    await prefetchRecentChats([row("p3")]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not retry a chat that failed in the same page load", async () => {
    invoke.mockRejectedValue(new Error("down"));
    await prefetchRecentChats([row("p4")]);
    await prefetchRecentChats([row("p4")]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("warms at most eight chats per page load however often the list refreshes", async () => {
    invoke.mockResolvedValue(page("hi"));
    const first = Array.from({ length: 10 }, (_, i) => row(`b${i}`));
    await prefetchRecentChats(first);
    const afterFirst = invoke.mock.calls.length;
    await prefetchRecentChats(Array.from({ length: 10 }, (_, i) => row(`c${i}`)));
    // Two earlier tests already spent two of the eight on this page load.
    expect(afterFirst).toBe(6);
    expect(invoke.mock.calls.length).toBe(afterFirst);
  }, 20000);
});

describe("afterChatOpen", () => {
  it("resolves at once when no chat open is in flight", async () => {
    const { afterChatOpen } = await import("../src/shared/chat/history-prefetch.ts");
    await afterChatOpen();
  });

  it("holds the statusbar's reads until the open settles, then lets them through", async () => {
    const { afterChatOpen } = await import("../src/shared/chat/history-prefetch.ts");
    holdPrefetch(true);
    let ran = false;
    const waiting = afterChatOpen().then(() => { ran = true; });
    await Promise.resolve();
    expect(ran).toBe(false);
    holdPrefetch(false);
    await waiting;
    expect(ran).toBe(true);
  });

  it("never waits on the desktop", async () => {
    const { afterChatOpen } = await import("../src/shared/chat/history-prefetch.ts");
    window.__TAURI__ = {};
    holdPrefetch(true);
    await afterChatOpen();
    holdPrefetch(false);
  });
});
