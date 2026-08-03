// The switch-back path must NOT rebuild the transcript. These cover the two
// halves of that: the renderer parks/drains live events while off-screen
// instead of rendering into a detached tree, and the pane cache hands the same
// DOM node back (LRU-evicting the coldest chat) rather than a fresh one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

if (!globalThis.window) {
  globalThis.window = {};
}

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
const cache = await import("../src/views/sessions/chat-pane-cache.ts");

function emptyPage() {
  return { events: [], oldest_seq: 0, newest_seq: 0, has_more: false };
}

describe("ChatRenderer live-render parking", () => {
  it("holds events while paused and renders them on resume", async () => {
    invokeMock.mockResolvedValue({
      events: [assistantEvent("first", 1)],
      oldest_seq: 1,
      newest_seq: 1,
      has_more: false,
    });
    const container = document.createElement("div");
    const r = new ChatRenderer(container);
    await r.attach("sess-park");
    await r.loadFromStore();
    const builtWhileVisible = r.messages.length;

    r.pauseLiveRender();
    sessionEvents.pushSynthetic("sess-park", userEvent("while-away", 0));
    expect(r.parkedEventCount).toBe(1);
    expect(r.messages.length).toBe(builtWhileVisible);

    r.resumeLiveRender();
    expect(r.parkedEventCount).toBe(0);
    expect(r.messages.length).toBe(builtWhileVisible + 1);
    r.detach();
  });

  it("detach clears the parked state so a reused renderer renders live again", async () => {
    invokeMock.mockResolvedValue(emptyPage());
    const r = new ChatRenderer(document.createElement("div"));
    await r.attach("sess-detach");
    r.pauseLiveRender();
    r.detach();
    await r.attach("sess-detach");
    sessionEvents.pushSynthetic("sess-detach", userEvent("live", 0));
    expect(r.parkedEventCount).toBe(0);
    expect(r.messages.length).toBe(1);
    r.detach();
  });
});

describe("chat pane cache", () => {
  beforeEach(() => {
    cache.dropAllRetainedChats();
  });

  it("returns the same messages element on re-take", async () => {
    invokeMock.mockResolvedValue(emptyPage());
    const el = document.createElement("div");
    const r = new ChatRenderer(el);
    await r.attach("sess-a");
    cache.retainChat("sess-a", r, el);

    const hit = cache.takeRetainedChat("sess-a");
    expect(hit).not.toBeNull();
    expect(hit.messagesEl).toBe(el);
    expect(hit.renderer).toBe(r);
  });

  it("evicts the least-recently-used chat past capacity and detaches it", async () => {
    invokeMock.mockResolvedValue(emptyPage());
    const made = [];
    for (let i = 0; i < 6; i++) {
      const el = document.createElement("div");
      const r = new ChatRenderer(el);
      await r.attach(`sess-${i}`);
      cache.retainChat(`sess-${i}`, r, el);
      made.push(r);
    }
    expect(cache.retainedChatIds()).toEqual([
      "sess-1", "sess-2", "sess-3", "sess-4", "sess-5",
    ]);
    // The evicted one is fully torn down, not merely forgotten.
    expect(made[0].currentSessionId()).toBeNull();
    expect(cache.takeRetainedChat("sess-0")).toBeNull();
  });

  it("re-taking a chat makes it most-recently-used", async () => {
    invokeMock.mockResolvedValue(emptyPage());
    for (let i = 0; i < 5; i++) {
      const el = document.createElement("div");
      const r = new ChatRenderer(el);
      await r.attach(`lru-${i}`);
      cache.retainChat(`lru-${i}`, r, el);
    }
    cache.takeRetainedChat("lru-0");
    const el = document.createElement("div");
    const r = new ChatRenderer(el);
    await r.attach("lru-new");
    cache.retainChat("lru-new", r, el);
    // lru-0 was refreshed, so lru-1 is now the coldest and goes instead.
    expect(cache.retainedChatIds()).toEqual([
      "lru-2", "lru-3", "lru-4", "lru-0", "lru-new",
    ]);
  });

  it("drops a retained chat whose parked backlog outgrew a cold reload", async () => {
    invokeMock.mockResolvedValue(emptyPage());
    const el = document.createElement("div");
    const r = new ChatRenderer(el);
    await r.attach("sess-flood");
    cache.retainChat("sess-flood", r, el);
    r.pauseLiveRender();
    for (let i = 0; i < 301; i++) {
      sessionEvents.pushSynthetic("sess-flood", userEvent(`flood-${i}`, 0));
    }
    expect(cache.takeRetainedChat("sess-flood")).toBeNull();
    expect(r.currentSessionId()).toBeNull();
  });
});
