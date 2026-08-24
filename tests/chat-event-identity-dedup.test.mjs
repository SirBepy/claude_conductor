// Todo 693 safe half: sigOf's content-only dedup collapsed two genuinely
// distinct live deliveries sharing text within DEDUP_WINDOW_MS. Fix: only a
// DIFFERENT-source match counts as a duplicate (see RecentSig.source).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { assistantEvent } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

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
      for (const cb of [...(listeners.get(channel) || [])]) cb({ payload });
    },
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
});

function finals(sid) {
  return sessionEvents.events(sid).filter((e) => e.type === "assistant_message" && !e.streaming);
}

describe("live dedup: identity over content hash (todo 693)", () => {
  it("two distinct same-text assistant finals from the SAME channel both survive", async () => {
    const sid = `sess-identity-${Math.random()}`;
    globalThis.window.__TAURI__ = makeBus();
    const bus = globalThis.window.__TAURI__;
    await sessionEvents.ensureWatchListener(sid);

    bus.emit(`chat-watch:${sid}`, assistantEvent("Yes.", 0));
    bus.emit(`chat-watch:${sid}`, assistantEvent("Yes.", 0));

    expect(finals(sid)).toHaveLength(2);
  });

  it("still collapses a genuine cross-source duplicate of the same turn", async () => {
    const sid = `sess-identity-cross-${Math.random()}`;
    globalThis.window.__TAURI__ = makeBus();
    const bus = globalThis.window.__TAURI__;
    await sessionEvents.loadInitial(sid);
    await sessionEvents.ensureWatchListener(sid);

    bus.emit(`chat-watch:${sid}`, assistantEvent("Yes.", 0));
    bus.emit(`chat:${sid}`, assistantEvent("Yes.", 0));

    expect(finals(sid)).toHaveLength(1);
  });
});
