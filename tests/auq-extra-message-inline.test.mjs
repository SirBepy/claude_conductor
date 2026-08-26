// @vitest-environment jsdom

// The card's own "additional message" note (review-step free-text box, see
// permission-modal/index.ts onSubmit) used to ship as a SEPARATE trailing user
// bubble below the resolved question card. It now folds into the SAME card via
// the <auq-extra/> sentinel (AUQ_EXTRA_SENTINEL) - never a second bubble.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

let invokeRouter;

beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
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
const { AUQ_ANSWER_SENTINEL, AUQ_EXTRA_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");

const ASK_TOOL = "mcp__cc_conductor__ask_user_question";

function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { r: new ChatRenderer(container), container };
}

function toolResult(id, text, isError = false) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: isError, timestamp: 0 };
}

const _seqByPrefix = new Map();
async function makeAttachedRenderer(prefix) {
  const seq = (_seqByPrefix.get(prefix) ?? 0) + 1;
  _seqByPrefix.set(prefix, seq);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`${prefix}${seq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("live: AUQ extra-message note folds into the card, not a separate bubble", () => {
  it("answer + extra note sent together (one message, two sentinel blocks) both fold into the SAME card", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));
    r.handleEvent(toolResult("q1", '{"acknowledged":true}'));
    r.handleEvent({
      type: "user_message",
      timestamp: 0,
      content: [
        { type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: Pick one?\nA: Option A` },
        { type: "text", text: `${AUQ_EXTRA_SENTINEL}also, please rerun the build afterwards` },
      ],
    });

    const q = r.messages.find((m) => m.kind === "question");
    expect(q.text).toContain("Option A");
    expect(q.extraText).toBe("also, please rerun the build afterwards");

    const card = container.querySelector(".msg.question-card");
    expect(card.textContent).toContain("also, please rerun the build afterwards");
    expect(card.querySelector(".question-card-extra-chip")).not.toBeNull();
    // No second bubble carries either sentinel's content ("go" is the only
    // legitimate .msg.user bubble in this transcript).
    const bubbles = [...container.querySelectorAll(".msg.user")];
    expect(bubbles.some((b) => b.textContent.includes("Option A") || b.textContent.includes("rerun the build"))).toBe(false);
    r.detach();
  });

  it("delivered:true - the tool_result already resolved the answer in-band; the note arrives as its own LATER message carrying only <auq-extra/>", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));
    // Real resolution text delivered directly on the tool_result (no <auq-answer/>
    // follow-up needed) - this is the `delivered: true` path.
    r.handleEvent(toolResult("q1", "User answered the question(s):\nQ: Pick one?\nA: Option A"));
    expect(r.messages.find((m) => m.kind === "question").text).toContain("Option A");

    // The note travels alone, in a later event.
    r.handleEvent({
      type: "user_message",
      timestamp: 0,
      content: [{ type: "text", text: `${AUQ_EXTRA_SENTINEL}one more thing - also check the flaky test` }],
    });

    const q = r.messages.find((m) => m.kind === "question");
    expect(q.extraText).toBe("one more thing - also check the flaky test");
    const card = container.querySelector(".msg.question-card");
    expect(card.textContent).toContain("one more thing - also check the flaky test");
    const bubbles = [...container.querySelectorAll(".msg.user")];
    expect(bubbles.some((b) => b.textContent.includes("flaky test"))).toBe(false);
    r.detach();
  });

  it("genuinely queued composer prose riding the same bundle still renders as a normal bubble", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));
    r.handleEvent(toolResult("q1", '{"acknowledged":true}'));
    r.handleEvent({
      type: "user_message",
      timestamp: 0,
      content: [
        { type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: Pick one?\nA: Option A` },
        { type: "text", text: `${AUQ_EXTRA_SENTINEL}a card note` },
        { type: "text", text: "also can you check why the tray icon flickers on wake?" },
      ],
    });

    const q = r.messages.find((m) => m.kind === "question");
    expect(q.extraText).toBe("a card note");
    const bubbles = [...container.querySelectorAll(".msg.user")];
    expect(bubbles.some((b) => b.textContent.includes("tray icon flickers"))).toBe(true);
    // The card note must not ALSO leak into the queued bubble.
    expect(bubbles.some((b) => b.textContent.includes("a card note"))).toBe(false);
    r.detach();
  });
});

describe("pagination (older-page load): AUQ extra-message note", () => {
  it("folds a same-batch answer+extra follow-up into the card's extraText, no separate bubble", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("later question", 2_000_000)],
      oldest_seq: 10,
      newest_seq: 10,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [
        userEvent("old question", 1_000_000),
        toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?" }] }, "q1", 1_001_000),
        toolResult("q1", '{"acknowledged":true}'),
        {
          type: "user_message",
          timestamp: 1_001_500,
          content: [
            { type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: Pick one?\nA: Real answer` },
            { type: "text", text: `${AUQ_EXTRA_SENTINEL}don't forget the changelog` },
          ],
        },
      ],
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });

    const { renderer, container } = await makeAttachedRenderer("sess-auq-extra-batch-");
    await renderer.fetchOlder();

    const card = container.querySelector(".msg.question-card");
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Real answer");
    expect(card.textContent).toContain("don't forget the changelog");
    expect(card.querySelector(".question-card-extra-chip")).not.toBeNull();
    const bubbles = [...container.querySelectorAll(".msg.user")];
    expect(bubbles.some((b) => b.textContent.includes("Real answer") || b.textContent.includes("changelog"))).toBe(false);
    renderer.detach();
  });

  it("folds a delivered:true (direct tool_result answer + later extra-only message) fold across two events", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("later question", 2_000_000)],
      oldest_seq: 10,
      newest_seq: 10,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [
        userEvent("old question", 1_000_000),
        toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?" }] }, "q1", 1_001_000),
        toolResult("q1", "User answered the question(s):\nQ: Pick one?\nA: Real answer", false),
        {
          type: "user_message",
          timestamp: 1_001_500,
          content: [{ type: "text", text: `${AUQ_EXTRA_SENTINEL}one more thing, also check flaky test` }],
        },
      ],
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });

    const { renderer, container } = await makeAttachedRenderer("sess-auq-extra-delivered-");
    await renderer.fetchOlder();

    const card = container.querySelector(".msg.question-card");
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Real answer");
    expect(card.textContent).toContain("one more thing, also check flaky test");
    const bubbles = [...container.querySelectorAll(".msg.user")];
    expect(bubbles.some((b) => b.textContent.includes("flaky test"))).toBe(false);
    renderer.detach();
  });
});
