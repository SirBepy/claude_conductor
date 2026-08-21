// Regression tests for ai_todo 47: duplicate assistant messages in the chat pane.
//
// The live stream delivers partial `assistant` lines (streaming:true) followed
// by a final non-streaming message from the `result` line. The renderer must
// replace-in-place rather than append for each incoming chunk, and must never
// render the same reply twice even when loadFromStore's chunk yields overlap
// with a concurrent live event.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, streamingEvent, finalEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

let invokeRouter;

// sidemenu.ts assigns to window at module-eval time before any beforeEach
// can run. Provide a bare stub so that first import doesn't throw.
if (!globalThis.window) {
  globalThis.window = {};
}

// Top-level dynamic imports run after vi.mock hoisting and after the early
// window stub above, but before any beforeEach. Modules are cached so the
// stub window is used only for the initial sidemenu.ts eval; each test gets
// a real JSDOM window via beforeEach below.
const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
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

describe("ChatRenderer — streaming dedup (ai_todo 47)", () => {
  it("streaming → final: renders exactly 1 assistant message", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent(streamingEvent("thinking…"), { silent: true });
    r.handleEvent(finalEvent("done"), { silent: true });
    const assistants = r.messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].streaming).toBe(false);
    expect(assistants[0].content[0].text).toBe("done");
  });

  it("multiple streaming chunks → final: replaces in-place, exactly 1 message", () => {
    const r = new ChatRenderer(document.createElement("div"));
    for (let i = 0; i < 5; i++) {
      r.handleEvent(streamingEvent(`chunk ${i}`), { silent: true });
    }
    r.handleEvent(finalEvent("final answer"), { silent: true });
    const assistants = r.messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content[0].text).toBe("final answer");
    expect(assistants[0].streaming).toBe(false);
  });

  it("final without prior streaming (history replay): exactly 1 message", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent(finalEvent("history reply"), { silent: true });
    expect(r.messages.filter((m) => m.kind === "assistant")).toHaveLength(1);
  });

  it("turn with tools: 1 user + tools + 1 final assistant, no extras", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 }, { silent: true });
    r.handleEvent(userEvent("do it"), { silent: true });
    r.handleEvent({ type: "tool_use", tool_name: "Bash", input: { command: "ls" }, id: "t1" }, { silent: true });
    r.handleEvent({ type: "tool_result", tool_use_id: "t1", output: "file.txt", is_error: false }, { silent: true });
    r.handleEvent(streamingEvent("running…"), { silent: true });
    r.handleEvent(finalEvent("done"), { silent: true });
    expect(r.messages.filter((m) => m.kind === "assistant")).toHaveLength(1);
    expect(r.messages.filter((m) => m.kind === "user")).toHaveLength(1);
  });

  it("loadFromStore: live final arriving during chunk yield produces 1 message (snapshot fix)", async () => {
    // Regression: loadInitial returns a live array reference. Without the snapshot
    // in loadFromStore, a final event arriving via pushSynthetic during a chunk yield
    // is (a) processed by the subscriber and (b) appended to the live array so
    // bulkLoadEvents also processes it in the next iteration — producing 2 messages.
    // The fix ([...events] snapshot) breaks (b), leaving only (a).
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const sid = `sess-race-${Math.random()}`;

    // 9 events → 2 iterations with 1 yield between them (CHUNK=8):
    //   iter 1: events 0-7 (user messages), then yield
    //   iter 2: event 8 (streaming assistant)
    const initialEvents = [
      ...Array.from({ length: 8 }, (_, i) => userEvent(`u${i}`, i)),
      streamingEvent("partial...", 8),
    ];

    invokeRouter.queueOnce("load_history_page", {
      events: initialEvents,
      oldest_seq: 0,
      newest_seq: 8,
      has_more: false,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach(sid);

    // Start loadFromStore but do not await — inject an event mid-flight.
    const loadPromise = r.loadFromStore();

    // Drain microtasks so: loadInitial resolves, bulkLoadEvents starts,
    // iteration 1 processes events 0-7 and queues a setTimeout(resolve, 0).
    // 4 ticks, not 3: the router's queued invoke resolves through one more
    // microtask hop than a raw mockResolvedValueOnce did (verified via
    // vi.getTimerCount() polling - routing mechanics only).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Inject the final event during the yield window. This fires the subscriber
    // synchronously (streamingIndex still null — iter 2 hasn't run yet).
    // Without the snapshot fix, pushSynthetic also grows the live events array,
    // so iter 2 would process streaming (index 8) then the final (index 9),
    // hitting the streamingIndex=null → append path and duplicating the message.
    sessionEvents.pushSynthetic(sid, finalEvent("final answer", 9));

    // Fire the queued setTimeout so iter 2 runs.
    vi.advanceTimersByTime(0);
    await loadPromise;
    vi.useRealTimers();

    const assistants = r.messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].streaming).toBe(false);
    expect(assistants[0].content[0].text).toBe("final answer");
  });
});
