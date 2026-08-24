// Repro for ai_todo 77: duplicate assistant messages when the file watcher
// (chat-watch:<id>) and the runner stream (chat:<id>) both deliver the same
// turn. Both live `-p` events carry timestamp=0, and the runner listener has
// NO dedup, so if the watcher wins the race the assistant renders twice.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { assistantEvent, streamingEvent, finalEvent, userEvent } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

// Minimal Tauri event bus: listen(channel, cb) registers; emit(channel, payload)
// fires all callbacks for that channel synchronously.
function makeBus() {
  const listeners = new Map();
  return {
    event: {
      async listen(channel, cb) {
        let arr = listeners.get(channel);
        if (!arr) { arr = []; listeners.set(channel, arr); }
        arr.push(cb);
        return () => {
          const a = listeners.get(channel);
          if (a) a.splice(a.indexOf(cb), 1);
        };
      },
    },
    emit(channel, payload) {
      const arr = listeners.get(channel) || [];
      for (const cb of [...arr]) cb({ payload });
    },
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
});

describe("runner + file-watcher dedup (ai_todo 77)", () => {
  it("watcher wins the race: assistant must render exactly once", async () => {
    const sid = `sess-dup-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;

    // Empty history for this session.
    invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach(sid);
    await r.loadFromStore();
    await sessionEvents.ensureWatchListener(sid);

    // User turn (synthetic echo, as the composer does).
    sessionEvents.pushSynthetic(sid, userEvent("hi", Date.now()));

    // RACE: the file watcher emits the finalized assistant FIRST (ts 0)...
    bus.emit(`chat-watch:${sid}`, assistantEvent("Hi Joe. Ready.", 0));
    // ...then the runner stream delivers the same turn (streaming + final, ts 0).
    bus.emit(`chat:${sid}`, streamingEvent("Hi Joe.", 0));
    bus.emit(`chat:${sid}`, finalEvent("Hi Joe. Ready.", 0));

    const assistants = r.messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(1);
  });

  it("runner wins the race: assistant must render exactly once", async () => {
    const sid = `sess-dup2-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach(sid);
    await r.loadFromStore();
    await sessionEvents.ensureWatchListener(sid);

    sessionEvents.pushSynthetic(sid, userEvent("hi", Date.now()));
    // Runner first, then the watcher catches up with the same finalized line.
    bus.emit(`chat:${sid}`, streamingEvent("Hi Joe.", 0));
    bus.emit(`chat:${sid}`, finalEvent("Hi Joe. Ready.", 0));
    bus.emit(`chat-watch:${sid}`, assistantEvent("Hi Joe. Ready.", 0));

    const assistants = r.messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(1);
  });
});
