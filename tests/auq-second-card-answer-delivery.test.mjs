// @vitest-environment jsdom

// Regression for todo 773: a SECOND ask_user_question card in the same live
// session must deliver its answer like the first, through the real
// showQuestionCard -> HeldMessages held-flush path (mocks only the DOM-heavy
// renderQuestionUI, same as the other permission-modal tests).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockIpc, mockQuestionUi, questionPayload as questionPayloadFor, flushMicrotasks, makeSentinelBlock } from "./helpers/auq-test-harness.mjs";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd) => {
    if (cmd === "get_session_drafts") {
      return Promise.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    }
    return Promise.resolve(undefined);
  }),
}));
mockIpc(invokeMock);

const { renderCalls, renderQuestionUISpy } = vi.hoisted(() => {
  const renderCalls = [];
  return { renderCalls, renderQuestionUISpy: vi.fn((opts) => { renderCalls.push(opts); }) };
});
import * as qs from "../src/views/sessions/permission-modal/question-state.ts";
mockQuestionUi(qs, renderQuestionUISpy);

const { handleQuestionRequested, setSelectedSessionId } = await import("../src/views/sessions/permission-modal/index.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");
const { isAuqAnswerBlock } = await import("../src/shared/chat/chat-transforms.ts");

const SESSION = "s1";

const questionPayload = (id) => questionPayloadFor(SESSION, id, `Pick one for ${id}?`);
const sentinelBlock = makeSentinelBlock(isAuqAnswerBlock);

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
