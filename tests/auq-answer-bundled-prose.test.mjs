// @vitest-environment jsdom
// asserts: src/shared/chat/chat-event-to-message.ts, src/shared/chat/chat-event-handler-messages.ts, src/shared/chat/chat-pagination.ts, src/shared/chat/dashboard/dashboard-model.ts
//
// Joe's answer to a question card can ride in one message with prose he typed
// and files he attached (held-messages.ts bundleHeld). The CLI writes a message
// made only of text blocks to the transcript as ONE string, so on replay the
// sentinel is no longer at the start of its block. It used to be matched only
// there, so the card stayed "awaiting answer" and drew under Waiting on you for
// good (reported 2026-11-21, a card asked 19 Nov and answered the same day).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { handleChatEvent } = await import("../src/shared/chat/chat-event-handler.ts");
const { extractAuqAnswerText, extractAuqAnswerCardId, stripAuqAnswerBlock } = await import("../src/shared/chat/chat-event-to-message.ts");
const { deriveWaiting, isOpenQuestion } = await import("../src/shared/chat/dashboard/dashboard-model.ts");

const ASK_TOOL = "mcp__cc_conductor__ask_user_question";
const ACK_TEXT = '{"acknowledged":true,"note":"the card is now waiting for their answer."}';
const QUESTIONS = { questions: [{ question: "What should go?", header: "Done card" }] };
const FILE = "<file:C:\\Users\\x\\chat-attachments\\a\\b.png::image.png>";
const ANSWER = 'User answered the question(s):\nQ: What should go?\nA: just the avatars';
const BUNDLED = `another\n${FILE}\n\n${FILE}\n<auq-answer id="q2"/>${ANSWER}`;

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

function toolResult(id, text, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: ts };
}

const answerMessage = (text, ts = 1_000_300) => ({ type: "user_message", timestamp: ts, content: [{ type: "text", text }] });

function questionRows(r) {
  return r.messages.filter((m) => m.kind === "question");
}

describe("the sentinel helpers read an answer that is not at the start of its block", () => {
  const blocks = [{ type: "text", text: BUNDLED }];

  it("finds the answer text and the card it names", () => {
    expect(extractAuqAnswerText(blocks)).toBe(ANSWER);
    expect(extractAuqAnswerCardId(blocks)).toBe("q2");
  });

  it("strip keeps the prose ahead of the answer and drops the answer", () => {
    const rest = stripAuqAnswerBlock(blocks);
    expect(rest).toHaveLength(1);
    expect(rest[0].text).toContain("another");
    expect(rest[0].text).not.toContain("auq-answer");
    expect(rest[0].text).not.toContain("User answered");
  });

  it("strip drops a block that is only the answer", () => {
    expect(stripAuqAnswerBlock([{ type: "text", text: `<auq-answer id="q2"/>${ANSWER}` }])).toEqual([]);
  });

  it("a sentinel in the middle of a line is not an answer", () => {
    expect(extractAuqAnswerText([{ type: "text", text: `quoting <auq-answer id="q2"/> here` }])).toBeNull();
  });
});

describe("a bundled answer resolves its card", () => {
  it("live: the card is answered and the prose stays a message", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    r.handleEvent(toolUseEvent(ASK_TOOL, QUESTIONS, "q2"));
    r.handleEvent(toolResult("q2", ACK_TEXT));
    r.handleEvent(answerMessage(BUNDLED));

    const cards = questionRows(r);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain("just the avatars");
    expect(r.messages.some((m) => m.kind === "user" && JSON.stringify(m.content).includes("another"))).toBe(true);
    expect(r.messages.some((m) => m.kind === "user" && JSON.stringify(m.content).includes("User answered"))).toBe(false);
  });

  it("replay one event at a time (the dashboard's shadow renderer): the card is not open", () => {
    const container = document.createElement("div");
    const r = new ChatRenderer(container);
    for (const ev of [toolUseEvent(ASK_TOOL, QUESTIONS, "q2"), toolResult("q2", ACK_TEXT), answerMessage(BUNDLED)]) {
      handleChatEvent(r, ev, { silent: true, skipScroll: true });
    }
    const cards = questionRows(r);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBeDefined();
    expect(cards.some(isOpenQuestion)).toBe(false);
  });

  it("scrollback: the card of an older page is answered and Waiting on you holds nothing", async () => {
    const router = makeInvokeRouter(invokeMock);
    router.queueOnce("load_history_page", { events: [userEvent("later", 2_000_000)], oldest_seq: 10, newest_seq: 12, has_more: true });
    router.queueOnce("load_history_page", {
      events: [
        userEvent("start", 1_000_000),
        toolUseEvent(ASK_TOOL, QUESTIONS, "q2", 1_000_200),
        toolResult("q2", ACK_TEXT, 1_000_250),
        answerMessage(BUNDLED, 1_000_300),
      ],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach("sess-auq-bundled");
    await r.loadFromStore();
    await r.fetchOlder();

    const cards = container.querySelectorAll(".question-card-collapsible");
    expect(cards).toHaveLength(1);
    expect(cards[0].dataset.resolution).toBe("answered");
    expect(questionRows(r).some(isOpenQuestion)).toBe(false);
    expect(deriveWaiting({ input: { messages: r.messages, plans: [] }, lastJoe: -1 })).toBeNull();
  });
});
