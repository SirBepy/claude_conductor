// send_message lifecycle in the chat pane. The 3x-duplicate bug: the bubble is
// built from the tool_use input, so a server-side rejection rendered anyway and
// every shortened retry stacked another near-identical bubble.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

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

const SEND = "mcp__cc_conductor__send_message";
const UPDATE = "mcp__cc_conductor__update_message";

function sendEvent(text, id) {
  return toolUseEvent(SEND, { text }, id);
}

function updateEvent(input, id) {
  return toolUseEvent(UPDATE, input, id);
}

function resultEvent(id, isError = false) {
  return {
    type: "tool_result",
    tool_use_id: id,
    output: { type: "text", text: isError ? "text exceeds 8000 chars" : '{"ok":true}' },
    is_error: isError,
    timestamp: 0,
  };
}

function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  r.handleEvent(userEvent("go"));
  return { r, container };
}

function bubbleTexts(container) {
  return [...container.querySelectorAll(".msg.assistant .block.text")].map((el) => el.textContent.trim());
}

describe("rejected send_message leaves no bubble", () => {
  it("drops the optimistic bubble when the tool_result is an error", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("a".repeat(50), "m1"));
    expect(bubbleTexts(container).length).toBe(1);

    r.handleEvent(resultEvent("m1", true));
    expect(bubbleTexts(container).length).toBe(0);
  });

  it("keeps the bubble when the send succeeded", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("all good", "m1"));
    r.handleEvent(resultEvent("m1"));
    expect(bubbleTexts(container)).toEqual(["all good"]);
  });

  it("a rejected long send followed by a shortened retry renders ONE bubble", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("the very long version", "m1"));
    r.handleEvent(resultEvent("m1", true));
    r.handleEvent(sendEvent("the short version", "m2"));
    r.handleEvent(resultEvent("m2"));
    expect(bubbleTexts(container)).toEqual(["the short version"]);
  });

  it("removing a rejected bubble keeps later rows rendering correctly", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("doomed", "m1"));
    r.handleEvent(assistantEvent("narration"));
    r.handleEvent(resultEvent("m1", true));
    r.handleEvent(sendEvent("kept", "m2"));
    r.handleEvent(resultEvent("m2"));
    expect(bubbleTexts(container)).toContain("kept");
    expect(bubbleTexts(container)).not.toContain("doomed");
    expect(r.messages.length).toBe(r.messageEls.length);
  });
});

describe("update_message revises and retracts", () => {
  it("message:1 swaps the newest bubble in place with no trace", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("tests failing", "m1"));
    r.handleEvent(resultEvent("m1"));
    r.handleEvent(updateEvent({ message: 1, text: "tests pass, stale process" }, "u1"));
    r.handleEvent(resultEvent("u1"));

    expect(bubbleTexts(container)).toEqual(["tests pass, stale process"]);
    expect(container.textContent).not.toContain("tests failing");
  });

  it("message:2 reaches the older of two bubbles", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("first", "m1"));
    r.handleEvent(resultEvent("m1"));
    r.handleEvent(sendEvent("second", "m2"));
    r.handleEvent(resultEvent("m2"));
    r.handleEvent(updateEvent({ message: 2, text: "first, corrected" }, "u1"));
    r.handleEvent(resultEvent("u1"));

    expect(bubbleTexts(container)).toEqual(["first, corrected", "second"]);
  });

  it("retract replaces the bubble with a struck placeholder", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("tests failing", "m1"));
    r.handleEvent(resultEvent("m1"));
    r.handleEvent(updateEvent({ message: 1, retract: true }, "u1"));
    r.handleEvent(resultEvent("u1"));

    expect(bubbleTexts(container)).toEqual([]);
    expect(container.querySelector(".retracted-chip")).not.toBeNull();
  });

  it("the ack row is absorbed - update_message never renders a tool_result", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("x", "m1"));
    r.handleEvent(resultEvent("m1"));
    r.handleEvent(updateEvent({ message: 1, text: "y" }, "u1"));
    r.handleEvent(resultEvent("u1"));
    expect(container.querySelectorAll(".msg.tool-result").length).toBe(0);
  });

  it("ignores a message outside the two-user-message window", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("ancient", "m1"));
    r.handleEvent(resultEvent("m1"));
    r.handleEvent(userEvent("next"));
    r.handleEvent(userEvent("next again"));
    r.handleEvent(updateEvent({ message: 1, text: "rewritten" }, "u1"));
    r.handleEvent(resultEvent("u1"));

    expect(bubbleTexts(container)).toEqual(["ancient"]);
  });
});

describe("interrupted turns dim their messages", () => {
  it("dims a bubble sent in a turn the user cancelled", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("committing now", "m1"));
    r.handleEvent(resultEvent("m1"));
    r.handleEvent(assistantEvent("[Request interrupted by user]"));

    expect(container.querySelector(".msg.assistant.dimmed")).not.toBeNull();
  });

  it("revising the dimmed bubble clears the dim", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(sendEvent("committing now", "m1"));
    r.handleEvent(resultEvent("m1"));
    r.handleEvent(assistantEvent("[Request interrupted by user]"));
    r.handleEvent(updateEvent({ message: 1, text: "commit cancelled" }, "u1"));
    r.handleEvent(resultEvent("u1"));

    expect(container.querySelector(".msg.assistant.dimmed")).toBeNull();
    expect(bubbleTexts(container)).toContain("commit cancelled");
  });
});
