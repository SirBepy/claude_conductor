// @vitest-environment jsdom
// asserts: src/shared/chat/chat-event-to-message.ts, src/shared/chat/chat-pagination.ts, src/shared/chat/chat-question-card.ts, src/shared/chat/chat-event-handler-messages.ts, src/shared/chat/tool-views.ts, src/shared/chat/question-texts.ts
//
// Joe's 2026-11-21 screenshots, round 2 of "Waiting on you lists answered cards":
//  1. a 6-question card where he wrote ONE note in the card's extra box and submitted
//     stayed "awaiting answer": the real submit is ONE string, the note FIRST and the
//     answer after it (`<auq-extra/>NOTE\n<auq-answer id="X"/>User answered ...`), and
//     an empty multiSelect answer rendered "awaiting answer" too;
//  2. a card row with no question text at all: an ask the MCP server refused for its
//     arguments (nothing was ever shown) still drew a card nobody could answer.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { isOpenQuestion } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { renderQuestionsView } = await import("../src/shared/chat/tool-views.ts");
const { extractAuqAnswerText, extractAuqExtraText, stripAuqAnswerBlock, stripAuqExtraBlock } = await import("../src/shared/chat/chat-event-to-message.ts");

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

const ASK = "mcp__cc_conductor__ask_user_question";
const ACK = '{"acknowledged":true}';
const QS = {
  questions: [
    { question: "Q1?", header: "A", multiSelect: false },
    { question: "Q2?", header: "B", multiSelect: true },
  ],
};
const ANSWER = "User answered the question(s):\nQ: Q1?\nA: (No answer provided)\nQ: Q2?\nA: ";
const EXTRA_FIRST = `<auq-extra/>ALSO WROTE\n<auq-answer id="q1"/>${ANSWER}`;

const result = (id, text, isError = false, ts = 0) => ({
  type: "tool_result",
  tool_use_id: id,
  output: { type: "text", text },
  is_error: isError,
  timestamp: ts,
});
const userMsg = (text, ts) => ({ type: "user_message", timestamp: ts, content: [{ type: "text", text }] });

let seq = 0;
async function load(pages) {
  const router = makeInvokeRouter(invokeMock);
  for (const p of pages) router.queueOnce("load_history_page", p);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(`sess-round2-${++seq}`);
  await r.loadFromStore();
  if (pages.length > 1) await r.fetchOlder();
  return { r, container };
}

const page = (events, extra = {}) => ({ events, oldest_seq: 1, newest_seq: 9, has_more: false, ...extra });
const questionRows = (r) => r.messages.filter((m) => m.kind === "question");
const cardsIn = (c) => c.querySelectorAll(".question-card-collapsible");

describe("a note written in the card's extra box and submitted with the answers", () => {
  it("replay: the card is answered, the note rides the card, no row is open or awaiting", async () => {
    const { r, container } = await load([
      page([userEvent("start", 1_000_000), toolUseEvent(ASK, QS, "q1", 1_000_200), result("q1", ACK, false, 1_000_250), userMsg(EXTRA_FIRST, 1_000_300)]),
    ]);
    const rows = questionRows(r);
    expect(rows.length).toBe(1);
    expect(rows[0].extraText).toBe("ALSO WROTE");
    // the note must not leak into the answer text, nor the answer into the note
    expect(rows[0].text).not.toContain("ALSO WROTE");
    expect(rows[0].extraText).not.toContain("User answered");
    expect(isOpenQuestion(rows[0])).toBe(false);
    expect(cardsIn(container)[0].dataset.resolution).toBe("answered");
    expect(container.textContent).not.toContain("awaiting answer");
    // and no stray user bubble carries either half
    expect(r.messages.filter((m) => m.kind === "user").map((m) => m.content[0].text)).toEqual(["start"]);
  });

  it("replay across a page boundary: the answer and note on the newer page still fold into the older page's card", async () => {
    const { r, container } = await load([
      page([userMsg(EXTRA_FIRST, 1_000_300), userEvent("later", 2_000_000)], { oldest_seq: 10, newest_seq: 12, has_more: true }),
      page([userEvent("start", 1_000_000), toolUseEvent(ASK, QS, "q1", 1_000_200), result("q1", ACK, false, 1_000_250)]),
    ]);
    const rows = questionRows(r);
    expect(rows.length).toBe(1);
    expect(isOpenQuestion(rows[0])).toBe(false);
    expect(rows[0].extraText).toBe("ALSO WROTE");
    expect(container.textContent).not.toContain("awaiting answer");
    // the raw bubble that rendered before the older page arrived is gone from the DOM,
    // and the note shows inside the card
    expect(container.textContent).not.toContain("User answered");
    expect(cardsIn(container)[0].textContent).toContain("ALSO WROTE");
    expect(container.textContent).toContain("later");
  });

  it("live: the same joined message resolves the card", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    r.handleEvent(toolUseEvent(ASK, QS, "q1", 1_000_200));
    r.handleEvent(result("q1", ACK, false, 1_000_250));
    expect(cardsIn(container)[0].textContent).toContain("awaiting answer");
    r.handleEvent(userMsg(EXTRA_FIRST, 1_000_300));
    expect(isOpenQuestion(questionRows(r)[0])).toBe(false);
    expect(questionRows(r)[0].extraText).toBe("ALSO WROTE");
    expect(container.textContent).not.toContain("awaiting answer");
  });

  it("the note lands on the card the answer names, not on the newest card", async () => {
    const { r } = await load([
      page([
        userEvent("start", 1_000_000),
        toolUseEvent(ASK, QS, "q1", 1_000_200),
        result("q1", ACK, false, 1_000_250),
        toolUseEvent(ASK, { questions: [{ question: "Other?", header: "C" }] }, "q2", 1_000_400),
        result("q2", ACK, false, 1_000_450),
        userMsg(EXTRA_FIRST, 1_000_500),
      ]),
    ]);
    // the answered card renders at its answer, after the still-open one, so look up by id
    const first = questionRows(r).find((m) => m.id === "q1");
    const second = questionRows(r).find((m) => m.id === "q2");
    expect(first.extraText).toBe("ALSO WROTE");
    expect(isOpenQuestion(first)).toBe(false);
    expect(second.extraText).toBeUndefined();
    expect(isOpenQuestion(second)).toBe(true);
  });
});

describe("live: the note lands on the card the answer names", () => {
  it("an older card answered out of order owns its note, the newest card stays open", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    r.handleEvent(toolUseEvent(ASK, QS, "q1", 1_000_200));
    r.handleEvent(result("q1", ACK, false, 1_000_250));
    r.handleEvent(toolUseEvent(ASK, { questions: [{ question: "Other?", header: "C" }] }, "q2", 1_000_400));
    r.handleEvent(result("q2", ACK, false, 1_000_450));
    r.handleEvent(userMsg(EXTRA_FIRST, 1_000_500));
    const first = questionRows(r).find((m) => m.id === "q1");
    const second = questionRows(r).find((m) => m.id === "q2");
    expect(first.extraText).toBe("ALSO WROTE");
    expect(isOpenQuestion(first)).toBe(false);
    expect(second.extraText).toBeUndefined();
    expect(isOpenQuestion(second)).toBe(true);
  });
});

describe("scrollback (an older page folded by fetchOlder)", () => {
  const olderPage = (events) => page(events, { oldest_seq: 1, newest_seq: 9, has_more: false });
  const newestPage = page([userEvent("later", 2_000_000)], { oldest_seq: 10, newest_seq: 12, has_more: true });

  it("the note lands on the card the answer names, not on the newest card", async () => {
    const { r } = await load([
      newestPage,
      olderPage([
        userEvent("start", 1_000_000),
        toolUseEvent(ASK, QS, "q1", 1_000_200),
        result("q1", ACK, false, 1_000_250),
        toolUseEvent(ASK, { questions: [{ question: "Other?", header: "C" }] }, "q2", 1_000_400),
        result("q2", ACK, false, 1_000_450),
        userMsg(EXTRA_FIRST, 1_000_500),
      ]),
    ]);
    const first = questionRows(r).find((m) => m.id === "q1");
    const second = questionRows(r).find((m) => m.id === "q2");
    expect(first.extraText).toBe("ALSO WROTE");
    expect(isOpenQuestion(first)).toBe(false);
    expect(second.extraText).toBeUndefined();
    expect(isOpenQuestion(second)).toBe(true);
  });

  it("an ask with no questions is not an open card", async () => {
    const { r, container } = await load([newestPage, olderPage([userEvent("start", 1_000_000), toolUseEvent(ASK, { questions: [] }, "q1", 1_000_200)])]);
    expect(questionRows(r).filter(isOpenQuestion).length).toBe(0);
    expect(cardsIn(container).length).toBe(0);
  });
});

describe("reading the card's two markers out of one text block", () => {
  const blocks = (text) => [{ type: "text", text }];
  const BODY = "User answered the question(s):\nQ: a\nA: b";

  it("each marker owns the text up to the next one, in either order", () => {
    const extraFirst = blocks(`<auq-extra/>note\n<auq-answer id="q1"/>${BODY}`);
    expect(extractAuqExtraText(extraFirst)).toBe("note");
    expect(extractAuqAnswerText(extraFirst)).toBe(BODY);
    const answerFirst = blocks(`<auq-answer id="q1"/>${BODY}\n<auq-extra/>note`);
    expect(extractAuqExtraText(answerFirst)).toBe("note");
    expect(extractAuqAnswerText(answerFirst)).toBe(BODY);
  });

  it("an older send glued the note onto the last answer line", () => {
    const glued = blocks(`<auq-answer id="q1"/>${BODY}<auq-extra/>note`);
    expect(extractAuqExtraText(glued)).toBe("note");
    expect(extractAuqAnswerText(glued)).toBe(BODY);
  });

  it("held prose typed with the card stays when either marker's text is taken out", () => {
    const withProse = blocks(`typed too\n<auq-extra/>note\n<auq-answer id="q1"/>${BODY}`);
    expect(stripAuqAnswerBlock(stripAuqExtraBlock(withProse))).toEqual(blocks("typed too"));
  });

  it("two answers in one block: none of either is left to draw as a bubble", () => {
    const two = blocks(`<auq-answer id="a"/>${BODY}\n<auq-answer id="b"/>${BODY}`);
    expect(stripAuqAnswerBlock(two)).toEqual([]);
    expect(extractAuqAnswerText(two)).toBe(BODY);
  });

  it("prose that merely mentions a marker mid-line is not one", () => {
    expect(extractAuqExtraText(blocks("what does <auq-extra/> do?"))).toBeNull();
    expect(extractAuqAnswerText(blocks('what does <auq-answer id="x"/> do?'))).toBeNull();
  });
});

describe("an empty answer is not 'awaiting answer'", () => {
  const rowOf = (extra) => ({ kind: "question", tool: ASK, input: QS, id: "q1", ts: 1, ...extra });

  it("renders a resolved card whose answers are all empty as 'No answer'", () => {
    const html = renderQuestionsView([rowOf({ text: ANSWER })], 0, 1);
    expect(html).not.toContain("awaiting answer");
    expect(html).toContain("No answer");
  });

  it("renders an answer text that does not parse as answered, not awaiting", () => {
    const html = renderQuestionsView([rowOf({ text: "User answered the question(s):" })], 0, 1);
    expect(html).not.toContain("awaiting answer");
  });

  it("still says awaiting answer while the card has no resolution at all", () => {
    expect(renderQuestionsView([rowOf({})], 0, 1)).toContain("awaiting answer");
  });
});

describe("an ask the MCP server refused for its arguments draws no card", () => {
  const refused = [
    ["questions is not an array", "`questions` must be an array of question objects."],
    ["questions is empty", "`questions` must contain at least one question."],
    ["a question is invalid", "Question 2 needs a `question` text. Nothing was shown to the user - nothing was asked. Fix the value(s) and call ask_user_question again."],
  ];
  for (const [name, text] of refused) {
    it(`replay: ${name}`, async () => {
      const { r, container } = await load([page([userEvent("start", 1_000_000), toolUseEvent(ASK, QS, "q1", 1_000_200), result("q1", text, true, 1_000_250)])]);
      expect(questionRows(r).filter(isOpenQuestion).length).toBe(0);
      expect(cardsIn(container).length).toBe(0);
    });

    it(`live: ${name}`, () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const r = new ChatRenderer(container);
      r.handleEvent(toolUseEvent(ASK, QS, "q1", 1_000_200));
      r.handleEvent(result("q1", text, true, 1_000_250));
      expect(questionRows(r).filter(isOpenQuestion).length).toBe(0);
      expect(cardsIn(container).length).toBe(0);
    });
  }

  it("an ask with no questions at all is not an open card even before its result arrives", async () => {
    const { r, container } = await load([page([userEvent("start", 1_000_000), toolUseEvent(ASK, { questions: [] }, "q1", 1_000_200)])]);
    expect(questionRows(r).filter(isOpenQuestion).length).toBe(0);
    expect(cardsIn(container).length).toBe(0);
  });

  it("a relay failure still draws the card: the ask may have reached the daemon", async () => {
    const { r } = await load([
      page([userEvent("start", 1_000_000), toolUseEvent(ASK, QS, "q1", 1_000_200), result("q1", "relay error: connection reset", true, 1_000_250)]),
    ]);
    expect(questionRows(r).length).toBe(1);
  });
});
