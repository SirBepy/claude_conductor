// @vitest-environment jsdom

// Regression: the MCP ask channel's tool_result is an `{"acknowledged":true}`
// receipt, not the answer. Absorbing it as the card's `.text` stranded the card
// on "awaiting answer" and hid it from the <auq-answer/> fold, so the answer
// landed as a separate chip. Also covers the re-anchor to the answer's slot.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { toolUseEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { AUQ_ANSWER_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");

const ASK_TOOL = "mcp__cc_conductor__ask_user_question";
const ACK_TEXT = '{"acknowledged":true,"note":"Your question has been shown to the user in the app and the card is now waiting for their answer."}';

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

function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { r: new ChatRenderer(container), container };
}

function toolResult(id, text, isError = false) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: isError, timestamp: 0 };
}

/** True when `a` appears before `b` in document order. */
function precedes(a, b) {
  return Boolean(a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
}

function askAndAck(r) {
  r.handleEvent(toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));
  r.handleEvent(toolResult("q1", ACK_TEXT));
}

describe("AUQ question card: ack receipt, fold, and re-anchor", () => {
  it("leaves the card open after the acknowledged-receipt tool_result", () => {
    const { r, container } = makeRenderer();
    askAndAck(r);

    const card = container.querySelector(".question-card-collapsible");
    expect(card.dataset.resolution).toBe("pending");
    expect(container.textContent).toContain("awaiting answer");
    // The receipt must never leak into the transcript as card content.
    expect(container.textContent).not.toContain("acknowledged");
  });

  it("folds the answer into the card and re-anchors it below the work that followed the ask", () => {
    const { r, container } = makeRenderer();
    askAndAck(r);
    r.handleEvent(toolUseEvent("mcp__cc_conductor__send_message", { text: "Question's up: pick one" }, "m1"));
    r.handleEvent(toolResult("m1", "ok"));
    r.handleEvent({
      type: "user_message",
      timestamp: 0,
      content: [
        { type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: Pick one?\nA: Option A` },
        { type: "text", text: "and also rerun the build afterwards" },
      ],
    });

    const cards = container.querySelectorAll(".question-card-collapsible");
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.dataset.resolution).toBe("answered");
    expect(card.textContent).toContain("Option A");
    expect(card.textContent).not.toContain("awaiting answer");
    // Answered means folded, so no separate click-to-reveal answer bubble.
    expect(container.querySelector(".auq-answer-chip")).toBeNull();
    // Resolved cards collapse to their summary row.
    expect(card.hasAttribute("open")).toBe(false);

    const nudge = [...container.querySelectorAll(".msg.assistant")]
      .find((el) => el.textContent.includes("Question's up"));
    const extra = [...container.querySelectorAll(".msg.user")]
      .find((el) => el.textContent.includes("rerun the build"));
    expect(precedes(nudge, card)).toBe(true);
    expect(precedes(card, extra)).toBe(true);
  });

  it("re-anchors a skipped card too, marked Skipped", () => {
    const { r, container } = makeRenderer();
    askAndAck(r);
    r.handleEvent(toolUseEvent("mcp__cc_conductor__send_message", { text: "Question's up: pick one" }, "m1"));
    r.handleEvent(toolResult("m1", "ok"));
    r.handleEvent({ type: "notification", kind: "question_skipped", body: "" });

    const card = container.querySelector(".question-card-collapsible");
    expect(card.dataset.resolution).toBe("skipped");
    expect(card.textContent).toContain("Skipped");
    const nudge = [...container.querySelectorAll(".msg.assistant")]
      .find((el) => el.textContent.includes("Question's up"));
    expect(precedes(nudge, card)).toBe(true);
  });
});
