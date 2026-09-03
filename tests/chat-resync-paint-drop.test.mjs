// Todo 693: chat-event-handler.ts's two named suspects are exonerated (see
// chat-renderer-streaming.test.mjs). The real cause, fixed here, is one
// layer down in event-store.ts's applyDelta (stale evRef across a
// same-turn block change silently overwrites the prior block).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, deltaEvent, finalEvent, toolUseEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

function assistantTexts(r) {
  return r.messages
    .filter((m) => m.kind === "assistant")
    .map((m) => (m.content ?? []).map((b) => b.text ?? "").join(""));
}

async function attached(sid, bus) {
  globalThis.window.__TAURI__ = bus;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(sid);
  await r.loadFromStore();
  return r;
}

describe("chat-resync paint-path drop (todo 693): same-turn block change", () => {
  it("keeps BOTH text blocks when Claude speaks, calls a tool, then speaks again in one turn", async () => {
    const sid = `sess-block-${Math.random()}`;
    const bus = makeBus();
    const r = await attached(sid, bus);

    bus.emit(`chat:${sid}`, userEvent("do the thing", 0));
    // Block 1: streams then the model pauses for a tool call - no turn
    // boundary event fires yet, so the accumulator never clears.
    bus.emit(`chat:${sid}`, deltaEvent("Block one ", 1, 1));
    bus.emit(`chat:${sid}`, deltaEvent("is done.", 1, 2));
    bus.emit(`chat:${sid}`, toolUseEvent("Bash", { command: "ls" }, "t1"));
    bus.emit(`chat:${sid}`, { type: "tool_result", tool_use_id: "t1", output: "file.txt", is_error: false, timestamp: 0 });
    // Block 2: a NEW content_block_start bumps the ordinal - text_block is
    // session-wide and never resets mid-turn, only at the turn's own close.
    bus.emit(`chat:${sid}`, deltaEvent("Block two ", 2, 1));
    bus.emit(`chat:${sid}`, deltaEvent("continues.", 2, 2));

    expect(assistantTexts(r)).toEqual(["Block one is done.", "Block two continues."]);
  });

  it("still collapses ordinary same-block deltas into one streaming bubble", async () => {
    const sid = `sess-sameblock-${Math.random()}`;
    const bus = makeBus();
    const r = await attached(sid, bus);

    bus.emit(`chat:${sid}`, userEvent("hi", 0));
    bus.emit(`chat:${sid}`, deltaEvent("Hel", 1, 1));
    bus.emit(`chat:${sid}`, deltaEvent("lo there", 1, 2));
    bus.emit(`chat:${sid}`, finalEvent("Hello there", 0));

    expect(assistantTexts(r)).toEqual(["Hello there"]);
  });

  it("a turn-boundary block change (ordinary next reply) still renders as its own single bubble", async () => {
    const sid = `sess-turnboundary-${Math.random()}`;
    const bus = makeBus();
    const r = await attached(sid, bus);

    bus.emit(`chat:${sid}`, userEvent("first", 0));
    bus.emit(`chat:${sid}`, deltaEvent("First reply", 1, 1));
    bus.emit(`chat:${sid}`, finalEvent("First reply", 0));
    bus.emit(`chat:${sid}`, userEvent("second", 0));
    bus.emit(`chat:${sid}`, deltaEvent("Second reply", 7, 1));
    bus.emit(`chat:${sid}`, finalEvent("Second reply", 0));

    expect(assistantTexts(r)).toEqual(["First reply", "Second reply"]);
  });
});
