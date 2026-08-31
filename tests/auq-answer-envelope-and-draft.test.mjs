// @vitest-environment jsdom

// Regression for todo 773: respond_question's raw `{ok, delivered}` result read
// as truthy, so showQuestionCard's `delivered ? [] : [answer]` built no answer
// block. With a typed draft pending the send still fired carrying only the
// draft - the 2026-08-29 field report's receipt (`I wa` arrived, answer did not).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd) => {
    if (cmd === "get_session_drafts") {
      return Promise.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    }
    // The shape HttpTransport used to hand back verbatim.
    if (cmd === "respond_question") return Promise.resolve({ ok: true, delivered: false });
    return Promise.resolve(undefined);
  }),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { renderCalls, renderQuestionUISpy } = vi.hoisted(() => {
  const renderCalls = [];
  return { renderCalls, renderQuestionUISpy: vi.fn((opts) => { renderCalls.push(opts); }) };
});
import * as qs from "../src/views/sessions/permission-modal/question-state.ts";
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
  snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
  isQuestionAnswered: (...a) => qs.isQuestionAnswered(...a),
  renderQuestionUI: (opts) => renderQuestionUISpy(opts),
}));

const { handleQuestionRequested, setSelectedSessionId } = await import("../src/views/sessions/permission-modal/index.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");
const { isAuqAnswerBlock } = await import("../src/shared/chat/chat-transforms.ts");

const SESSION = "s1";
let sendCalls;
let draftText;

function questionPayload(id) {
  return {
    id,
    session_id: SESSION,
    questions: [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }],
  };
}

beforeEach(() => {
  renderCalls.length = 0;
  renderQuestionUISpy.mockClear();
  invokeMock.mockClear();
  qs.setActiveCard(null);
  localStorage.clear();

  state.sessions = [{ session_id: SESSION }];
  state.selectedId = SESSION;
  state.pendingNewSession = null;
  setSelectedSessionId(SESSION);

  sendCalls = [];
  draftText = "";
  state.heldMessages = new HeldMessages();
  state.heldMessages.attach({
    sessionId: SESSION,
    chipSlot: document.createElement("div"),
    anchor: document.createElement("div"),
    send: (blocks) => { sendCalls.push(blocks); },
    interrupt: () => {},
    getDraftBlocks: () => (draftText ? [{ type: "text", text: draftText }] : []),
    isDraftEmpty: () => draftText.length === 0,
    isComposing: () => false,
    clearComposer: () => { draftText = ""; },
    getIsBusy: () => false,
    onChange: () => {},
  });
});

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sentinelBlock(blocks) {
  // The production predicate, not a literal: the sentinel now carries the
  // answered card's id, so an exact-string match would miss every real block.
  return blocks.find(isAuqAnswerBlock);
}

async function answerOneCard() {
  handleQuestionRequested(questionPayload("q1"));
  await flushMicrotasks();
  expect(renderCalls.length).toBe(1);
  await renderCalls[0].onSubmit({ "Pick one?": "A" }, { additionalMessage: "", attachments: [] });
}

describe("respond_question's envelope never counts as an in-band delivery", () => {
  it("still sends the answer block when the transport returns {ok, delivered:false}", async () => {
    await answerOneCard();
    expect(sendCalls.length).toBe(1);
    const answer = sentinelBlock(sendCalls[0]);
    expect(answer).toBeDefined();
    expect(answer.text).toContain("A");
  });

  it("sends the typed composer draft AND the answer when both are pending", async () => {
    draftText = "I wa";
    await answerOneCard();
    expect(sendCalls.length).toBe(1);
    const texts = sendCalls[0].filter((b) => b.type === "text").map((b) => b.text);
    expect(texts.some((t) => t.includes("I wa"))).toBe(true);
    const answer = sentinelBlock(sendCalls[0]);
    expect(answer).toBeDefined();
    expect(answer.text).toContain("A");
  });
});
