// @vitest-environment jsdom
// Regression: the older-page (scrollback) path hid send_message calls as
// narration instead of rendering them as bubbles, a known gap in
// project_quiet_mode_chat_architecture. Fixed via eventToRenderedMessage.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";

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

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

function sendMessageEvent(text, id, ts = 0) {
  return toolUseEvent("mcp__cc_conductor__send_message", { text }, id, ts);
}

function toolResultEvent(id, { isError = false } = {}, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "" }, is_error: isError, timestamp: ts };
}

let _sessSeq = 0;
async function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-send-msg-test-${++_sessSeq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("older-page send_message rendering", () => {
  it("renders a scrolled-back send_message as a visible bubble, not hidden narration", async () => {
    invokeMock
      .mockResolvedValueOnce({
        events: [userEvent("later question", 2_000_000), assistantEvent("later answer", 2_001_000)],
        oldest_seq: 10,
        newest_seq: 12,
        has_more: true,
      })
      .mockResolvedValueOnce({
        events: [
          userEvent("old question", 1_000_000),
          sendMessageEvent("hey, done with the old thing", "m1", 1_001_000),
          toolResultEvent("m1", {}, 1_001_500),
        ],
        oldest_seq: 0,
        newest_seq: 9,
        has_more: false,
      });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    const bubbles = [...container.querySelectorAll(".msg.assistant")].filter(
      (el) => !el.classList.contains("chat-narration"),
    );
    expect(bubbles.some((el) => el.textContent.includes("hey, done with the old thing"))).toBe(true);
  });

  it("drops a rejected send_message (validation error) instead of leaving a ghost bubble", async () => {
    invokeMock
      .mockResolvedValueOnce({
        events: [userEvent("later question", 2_000_000), assistantEvent("later answer", 2_001_000)],
        oldest_seq: 10,
        newest_seq: 12,
        has_more: true,
      })
      .mockResolvedValueOnce({
        events: [
          userEvent("old question", 1_000_000),
          sendMessageEvent("too long, rejected", "m2", 1_001_000),
          toolResultEvent("m2", { isError: true }, 1_001_500),
          sendMessageEvent("shorter retry", "m3", 1_002_000),
          toolResultEvent("m3", {}, 1_002_500),
        ],
        oldest_seq: 0,
        newest_seq: 9,
        has_more: false,
      });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    expect(container.textContent).not.toContain("too long, rejected");
    expect(container.textContent).toContain("shorter retry");
  });
});
