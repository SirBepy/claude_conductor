// @vitest-environment jsdom

// Regression: top-level asks now render as kind:"question" (chat-event-to-message.ts),
// but renderQuestionsView (tool-views.ts) still filtered on kind:"tool_use", leaving the
// statusline "Questions" chip's drill-down popover (ChatRenderer.customToolView) empty.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

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

function toolResultEvent(id, text) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: 0 };
}

describe("statusline Questions chip drill-down popover (ChatRenderer.customToolView)", () => {
  it("is non-empty for a top-level MCP-asked question", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUseEvent(
      "mcp__cc_conductor__ask_user_question",
      { questions: [{ question: "Pick one?", header: "Choice" }] },
      "q1",
    ));
    r.handleEvent(toolResultEvent("q1", "User answered the question(s):\nQ: Pick one?\nA: Option A"));

    const html = r.customToolView("AskUserQuestion");
    expect(html).not.toBeNull();
    expect(html).not.toBe("");
    expect(html).toContain("Option A");
    r.detach();
  });
});
