// @vitest-environment jsdom
// asserts: src/shared/chat/chat-question-card.ts, src/shared/chat/chat-pagination.ts, src/shared/chat/chat-dom-renderer.ts, src/shared/chat/turn-visible-content.ts, src/shared/chat/chat-next-actions.ts, src/shared/chat/tool-views.ts
//
// A PreToolUse hook can bounce an ask_user_question call before the daemon sees
// it: the MCP ask answered with an is_error text containing "hook error". The
// transcript still holds that tool_use, so it used to draw as an "awaiting
// answer" card that nothing would ever answer, stacked above the model's retry
// of the same question (reported 2026-11-09). Any other is_error result (the
// builtin's deny handshake, a daemon-side failure) did surface a card and is
// not treated as a refusal.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { AUQ_ANSWER_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");
const { isHookRefusedAsk } = await import("../src/shared/chat/chat-question-card.ts");
const { turnProducedVisibleContent } = await import("../src/shared/chat/turn-visible-content.ts");
const { startsTurn, currentTurnNextActions } = await import("../src/shared/chat/chat-next-actions.ts");
const { renderQuestionsView } = await import("../src/shared/chat/tool-views.ts");

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

  it("scrollback: a skip mark lands on the real card, not the refused ask after it", async () => {
    const router = makeInvokeRouter(invokeMock);
    router.queueOnce("load_history_page", { events: [userEvent("later", 2_000_000)], oldest_seq: 10, newest_seq: 12, has_more: true });
    router.queueOnce("load_history_page", {
      events: [
        userEvent("start", 1_000_000),
        toolUseEvent(ASK_TOOL, QUESTIONS, "q1", 1_000_100),
        toolResult("q1", ACK_TEXT, false, 1_000_150),
        toolUseEvent(ASK_TOOL, QUESTIONS, "q2", 1_000_200),
        toolResult("q2", HOOK_ERROR, true, 1_000_250),
      ],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const renderer = new ChatRenderer(container);
    await renderer.attach("sess-auq-hook-refused-skip");
    await renderer.loadFromStore();
    renderer.paginator.skipMarks = [{ timestamp: 1_000_500 }];
    await renderer.fetchOlder();

    const cards = cardsIn(container);
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.resolution).toBe("skipped");
  });

  it("scrollback: an answer lands on the real card, not the refused ask after it", async () => {
    const router = makeInvokeRouter(invokeMock);
    router.queueOnce("load_history_page", { events: [userEvent("later", 2_000_000)], oldest_seq: 10, newest_seq: 12, has_more: true });
    router.queueOnce("load_history_page", {
      events: [
        userEvent("start", 1_000_000),
        toolUseEvent(ASK_TOOL, QUESTIONS, "q1", 1_000_100),
        toolResult("q1", ACK_TEXT, false, 1_000_150),
        toolUseEvent(ASK_TOOL, QUESTIONS, "q2", 1_000_200),
        toolResult("q2", HOOK_ERROR, true, 1_000_250),
        {
          type: "user_message",
          timestamp: 1_000_300,
          content: [{ type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: How should it behave?\nA: Option A` }],
        },
      ],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const renderer = new ChatRenderer(container);
    await renderer.attach("sess-auq-hook-refused-answer");
    await renderer.loadFromStore();
    await renderer.fetchOlder();

    const cards = cardsIn(container);
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.resolution).toBe("answered");
    expect(cards[0].textContent).toContain("Option A");
  });
});

describe("isHookRefusedAsk matches only a hook-blocked MCP ask", () => {
  const ask = { tool: ASK_TOOL };
  const result = (over) => ({ ...toolResult("q1", HOOK_ERROR, true), ...over });

  it("matches the MCP ask's is_error text naming a hook error", () => {
    expect(isHookRefusedAsk(ask, result({}))).toBe(true);
  });

  it("does not match a non-hook is_error result", () => {
    expect(isHookRefusedAsk(ask, result({ output: { type: "text", text: "daemon unreachable" } }))).toBe(false);
  });

  it("does not match hook-error text on a result that is not an error", () => {
    expect(isHookRefusedAsk(ask, result({ is_error: false }))).toBe(false);
  });

  it("does not match the builtin AskUserQuestion tool", () => {
    expect(isHookRefusedAsk({ tool: "AskUserQuestion" }, result({}))).toBe(false);
  });

  it("does not match a non-text output", () => {
    expect(isHookRefusedAsk(ask, result({ output: { type: "image", data: "x" } }))).toBe(false);
    expect(isHookRefusedAsk(ask, result({ output: undefined }))).toBe(false);
  });
});

describe("a refused ask row is not content, a turn start, or a pending question", () => {
  const refused = { kind: "question", id: "q1", text: "", failed: true, input: QUESTIONS, ts: 1 };
  const open = { kind: "question", id: "q2", input: QUESTIONS, ts: 1 };

  it("does not count as visible content of the turn", () => {
    expect(turnProducedVisibleContent({ activeTurnStart: 0, messages: [refused], sessionId: null })).toBe(false);
    expect(turnProducedVisibleContent({ activeTurnStart: 0, messages: [open], sessionId: null })).toBe(true);
  });

  it("does not start a turn, so the chips above it survive", () => {
    expect(startsTurn(refused)).toBe(false);
    expect(startsTurn(open)).toBe(true);
    const message = { kind: "message", nextActions: ["Go"] };
    expect(currentTurnNextActions([message, refused])).toEqual(["Go"]);
    expect(currentTurnNextActions([message, open])).toEqual([]);
  });

  it("is left out of the Questions tool view", () => {
    const html = renderQuestionsView([refused], 0, 1);
    expect(html).not.toContain("awaiting answer");
    expect(html).toBe("");
    expect(renderQuestionsView([refused, open], 0, 2)).toContain("awaiting answer");
  });
});
