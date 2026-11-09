// @vitest-environment jsdom
// asserts: src/shared/chat/chat-question-card.ts, src/shared/chat/chat-pagination.ts, src/shared/chat/chat-dom-renderer.ts
//
// A PreToolUse hook (or any other refusal) can bounce an ask_user_question call
// before the daemon sees it. The transcript still holds that tool_use, so it used
// to draw as an "awaiting answer" card that nothing would ever answer, stacked
// above the model's retry of the same question (reported 2026-11-09).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { AUQ_ANSWER_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");

const ASK_TOOL = "mcp__cc_conductor__ask_user_question";
const HOOK_ERROR = 'PreToolUse:mcp__cc_conductor__ask_user_question hook error: [python "guard.py"]: blocked before Joe sees it';
const ACK_TEXT = '{"acknowledged":true,"note":"the card is now waiting for their answer."}';
const QUESTIONS = { questions: [{ question: "How should it behave?", header: "Behaviour" }] };

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

function toolResult(id, text, isError, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: isError, timestamp: ts };
}

function cardsIn(container) {
  return container.querySelectorAll(".question-card-collapsible");
}

describe("an ask the hook refused draws no card", () => {
  it("live: the refused call's card is taken back and the retry is the only one", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent(toolUseEvent(ASK_TOOL, QUESTIONS, "q1"));
    r.handleEvent(toolResult("q1", HOOK_ERROR, true));
    r.handleEvent(toolUseEvent(ASK_TOOL, QUESTIONS, "q2"));
    r.handleEvent(toolResult("q2", ACK_TEXT, false));

    expect(cardsIn(container).length).toBe(1);
    expect(cardsIn(container)[0].textContent).toContain("awaiting answer");
  });

  it("live: the answer lands on the real card, not the refused one", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent(toolUseEvent(ASK_TOOL, QUESTIONS, "q1"));
    r.handleEvent(toolResult("q1", HOOK_ERROR, true));
    r.handleEvent(toolUseEvent(ASK_TOOL, QUESTIONS, "q2"));
    r.handleEvent(toolResult("q2", ACK_TEXT, false));
    r.handleEvent({
      type: "user_message",
      timestamp: 0,
      content: [{ type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: How should it behave?\nA: Option A` }],
    });

    const cards = cardsIn(container);
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.resolution).toBe("answered");
    expect(cards[0].textContent).toContain("Option A");
  });

  it("scrollback: a refused ask in an older page draws no card either", async () => {
    const router = makeInvokeRouter(invokeMock);
    router.queueOnce("load_history_page", { events: [userEvent("later", 2_000_000)], oldest_seq: 10, newest_seq: 12, has_more: true });
    router.queueOnce("load_history_page", {
      events: [
        userEvent("start", 1_000_000),
        toolUseEvent(ASK_TOOL, QUESTIONS, "q1", 1_000_100),
        toolResult("q1", HOOK_ERROR, true, 1_000_150),
        toolUseEvent(ASK_TOOL, QUESTIONS, "q2", 1_000_200),
        toolResult("q2", ACK_TEXT, false, 1_000_250),
      ],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const renderer = new ChatRenderer(container);
    await renderer.attach("sess-auq-hook-refused");
    await renderer.loadFromStore();
    await renderer.fetchOlder();

    expect(cardsIn(container).length).toBe(1);
  });
});
