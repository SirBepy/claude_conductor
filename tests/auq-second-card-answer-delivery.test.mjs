// @vitest-environment jsdom

// Regression for todo 773: a SECOND ask_user_question card in the same live
// session must deliver its answer like the first, through the real
// showQuestionCard -> HeldMessages held-flush path (mocks only the DOM-heavy
// renderQuestionUI, same as the other permission-modal tests).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd) => {
    if (cmd === "get_session_drafts") {
      return Promise.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    }
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
const { AUQ_ANSWER_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");

const SESSION = "s1";

function questionPayload(id) {
  return {
    id,
    session_id: SESSION,
    questions: [{ question: `Pick one for ${id}?`, options: [{ label: "A" }, { label: "B" }] }],
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

  const sendCalls = [];
  state.heldMessages = new HeldMessages();
  state.heldMessages.attach({
    sessionId: SESSION,
    chipSlot: document.createElement("div"),
    anchor: document.createElement("div"),
    send: (blocks) => { sendCalls.push(blocks); },
    interrupt: () => {},
    getDraftBlocks: () => [],
    isDraftEmpty: () => true,
    isComposing: () => false,
    clearComposer: () => {},
    getIsBusy: () => false,
    onChange: () => {},
  });
  state.sendCalls = sendCalls; // stash for assertions
});

// showQuestionCard chains several awaits (fetchFreshestAuqDraft -> invoke ->
// its own .then) before renderQuestionUI runs - a macrotask tick clears all
// of them at once instead of guessing the microtask depth.
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sentinelBlock(blocks) {
  return blocks.find((b) => b.type === "text" && b.text.startsWith(AUQ_ANSWER_SENTINEL));
}

describe("two ask_user_question cards in one session both deliver their answer", () => {
  it("delivers the auq-answer payload for BOTH the first and second card", async () => {
    handleQuestionRequested(questionPayload("q1"));
    await flushMicrotasks();
    expect(renderCalls.length).toBe(1);
    await renderCalls[0].onSubmit({ "Pick one for q1?": "A" }, { additionalMessage: "", attachments: [] });

    expect(state.sendCalls.length).toBe(1);
    const first = sentinelBlock(state.sendCalls[0]);
    expect(first).toBeDefined();
    expect(first.text).toContain("A");

    handleQuestionRequested(questionPayload("q2"));
    await flushMicrotasks();
    expect(renderCalls.length).toBe(2);
    await renderCalls[1].onSubmit({ "Pick one for q2?": "B" }, { additionalMessage: "", attachments: [] });

    expect(state.sendCalls.length).toBe(2);
    const second = sentinelBlock(state.sendCalls[1]);
    expect(second).toBeDefined();
    expect(second.text).toContain("B");
  });
});
