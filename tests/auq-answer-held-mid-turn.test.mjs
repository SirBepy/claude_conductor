// @vitest-environment jsdom

// The MCP ask tool is fire-and-forget, so the turn that asked is often still
// running when the answer is submitted. The answer is then held and nudge.rs
// injects it mid-turn, arriving as a `heldDelivered` user_message. It must
// still fold into the question card it answers, not render as a plain bubble
// that leaves the card stuck on "awaiting answer" (found by the billed
// question-card-live wdio spec, 2026-10-06).

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent, streamingEvent, finalEvent } from "./helpers/chat-events.mjs";

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");

beforeEach(() => {
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
  resetTransportForTests();
});

/** Marked exactly as sessions-wiring.ts's held-messages-delivered handler does. */
function heldDelivered(blocks) {
  return { type: "user_message", content: blocks, timestamp: 0, heldDelivered: true };
}

function ackResult(id) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: '{"acknowledged":true}' }, is_error: false, timestamp: 0 };
}

function askedMidTurn() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  r.handleEvent(userEvent("go"));
  r.handleEvent(toolUseEvent("mcp__cc_conductor__ask_user_question", { questions: [{ question: "Tabs or spaces?" }] }, "q1"));
  r.handleEvent(ackResult("q1"));
  // The turn keeps going after the ack, so the answer lands mid-turn.
  r.handleEvent(streamingEvent("Asked you"));
  return { r, container };
}

const ANSWER = '<auq-answer id="q1"/>User answered the question(s):\nQ: Tabs or spaces?\nA: spaces';

describe("a held auq-answer delivered mid-turn", () => {
  it("resolves the question card instead of rendering a plain bubble", () => {
    const { r, container } = askedMidTurn();
    r.handleEvent(heldDelivered([{ type: "text", text: ANSWER }]));
    r.handleEvent(finalEvent("Asked you, done"));

    const card = r.messages.find((m) => m.kind === "question");
    expect(card.text).toContain("A: spaces");
    expect(r.messages.some((m) => m.kind === "user" && m.content?.some((b) => b.text?.includes("auq-answer")))).toBe(false);
    expect(container.querySelector(".question-card-collapsible")?.getAttribute("data-resolution")).toBe("answered");
    r.detach();
  });

  it("still renders prose bundled with the answer as its own bubble", () => {
    const { r } = askedMidTurn();
    r.handleEvent(heldDelivered([{ type: "text", text: ANSWER }, { type: "text", text: "also, use 2 of them" }]));

    expect(r.messages.find((m) => m.kind === "question").text).toContain("A: spaces");
    const bubbles = r.messages.filter((m) => m.kind === "user").map((m) => m.content.map((b) => b.text).join(""));
    expect(bubbles).toContain("also, use 2 of them");
    expect(bubbles.some((t) => t.includes("auq-answer"))).toBe(false);
    r.detach();
  });
});
