// @vitest-environment jsdom
// Older-page (scrollback) mirror of chat-event-handler's moveMessageToEnd: a
// card whose <auq-answer/> lands later in the page renders at the ANSWER's
// position, resolved - and the `{"acknowledged":true}` receipt never resolves it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

// loadFromStore's Promise.all fires get_skipped_question_marks before the
// initial load_history_page resolves, so a raw positional queue desyncs. The
// router's per-command FIFO keeps the two pages in call order regardless.
function routePages(newestPage, olderPage) {
  const router = makeInvokeRouter(invokeMock);
  router.queueOnce("load_history_page", newestPage);
  router.queueOnce("load_history_page", olderPage);
}

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
const { AUQ_ANSWER_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");

const ASK_TOOL = "mcp__cc_conductor__ask_user_question";
const ACK_TEXT = '{"acknowledged":true,"note":"the card is now waiting for their answer."}';

function toolResultEvent(id, text, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: ts };
}

let _sessSeq = 0;
async function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-auq-page-${++_sessSeq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("older-page AUQ card re-anchor", () => {
  it("renders the answered card where the answer landed, not at the ask site", async () => {
    routePages(
      { events: [userEvent("later question", 2_000_000)], oldest_seq: 10, newest_seq: 12, has_more: true },
      {
        events: [
          userEvent("start", 1_000_000),
          toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1", 1_000_100),
          toolResultEvent("q1", ACK_TEXT, 1_000_150),
          toolUseEvent("mcp__cc_conductor__send_message", { text: "Question's up: pick one" }, "m1", 1_000_200),
          toolResultEvent("m1", "ok", 1_000_250),
          {
            type: "user_message",
            timestamp: 1_000_300,
            content: [
              { type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: Pick one?\nA: Option A` },
              { type: "text", text: "and also rerun the build" },
            ],
          },
          assistantEvent("on it", 1_000_400),
        ],
        oldest_seq: 1,
        newest_seq: 9,
        has_more: false,
      },
    );

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    const cards = container.querySelectorAll(".question-card-collapsible");
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.dataset.resolution).toBe("answered");
    expect(card.textContent).toContain("Option A");
    expect(container.querySelector(".auq-answer-chip")).toBeNull();

    const nudge = [...container.querySelectorAll(".msg.assistant")]
      .find((el) => el.textContent.includes("Question's up"));
    const extra = [...container.querySelectorAll(".msg.user")]
      .find((el) => el.textContent.includes("rerun the build"));
    expect(Boolean(nudge.compareDocumentPosition(card) & 4)).toBe(true);
    expect(Boolean(card.compareDocumentPosition(extra) & 4)).toBe(true);
  });

  // Regression for todo 706's consolidation: two asks in one page must each
  // fold their OWN answer via findNearestOpenQuestionId, same "one AUQ in
  // flight" rule as the live path - not cross-match to the wrong ask.
  it("folds two sequential asks in one page to their own answers, not swapped", async () => {
    routePages(
      { events: [userEvent("later", 2_000_000)], oldest_seq: 10, newest_seq: 12, has_more: true },
      {
        events: [
          toolUseEvent(ASK_TOOL, { questions: [{ question: "First?", header: "Choice A" }] }, "q1", 1_000_000),
          toolResultEvent("q1", ACK_TEXT, 1_000_050),
          {
            type: "user_message",
            timestamp: 1_000_100,
            content: [{ type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: First?\nA: First answer` }],
          },
          toolUseEvent(ASK_TOOL, { questions: [{ question: "Second?", header: "Choice B" }] }, "q2", 1_000_200),
          toolResultEvent("q2", ACK_TEXT, 1_000_250),
          {
            type: "user_message",
            timestamp: 1_000_300,
            content: [{ type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: Second?\nA: Second answer` }],
          },
        ],
        oldest_seq: 1,
        newest_seq: 9,
        has_more: false,
      },
    );

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    const cards = container.querySelectorAll(".question-card-collapsible");
    expect(cards.length).toBe(2);
    expect(cards[0].textContent).toContain("First answer");
    expect(cards[0].textContent).not.toContain("Second answer");
    expect(cards[1].textContent).toContain("Second answer");
    expect(cards[1].textContent).not.toContain("First answer");
  });
});
