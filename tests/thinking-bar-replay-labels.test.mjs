// @vitest-environment jsdom

// Cold-opening a busy chat whose transcript tail already carries a
// <cc-progress:N/M> marker used to show a bare "Thinking..." because the
// field write lived inside the same !hydrating gate as its callback, so
// replay never populated it for syncThinkingBar to read afterward.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { initThinkingBar, syncThinkingBar } = await import("../src/views/sessions/session-thinking-bar.ts");
const { state } = await import("../src/views/sessions/state.ts");

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

function makePane() {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="session-thinking" hidden><span class="thinking-text"></span></div>`;
  initThinkingBar(pane);
  return pane;
}

function barText(pane) {
  return pane.querySelector(".thinking-text").textContent;
}

function transcriptWithProgress() {
  return [
    { type: "user_message", content: [{ type: "text", text: "go" }], timestamp: 1 },
    {
      type: "assistant_message",
      content: [{ type: "text", text: "Working on it <cc-progress:2/5>" }],
      streaming: false,
      timestamp: 2,
    },
  ];
}

async function replay(events) {
  invokeMock.mockResolvedValue({ events, oldest_seq: 1, newest_seq: events.length, has_more: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach("s-progress");
  await r.loadFromStore(undefined, { resumeLiveTicking: true });
  return r;
}

describe("thinking bar survives history replay", () => {
  it("reads Step 2 of 5 after a cold bulk-load of a busy transcript", async () => {
    const pane = makePane();
    state.selectedId = "s-progress";
    state.sessions = [{ session_id: "s-progress", busy: true }];
    const r = await replay(transcriptWithProgress());

    syncThinkingBar(r);

    expect(barText(pane)).toBe("Step 2 of 5");
    r.detach();
  });
});
