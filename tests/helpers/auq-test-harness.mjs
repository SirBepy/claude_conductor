// Shared setup for the two AUQ permission-modal delivery test suites
// (todo 822). vi.mock's static hoist only rewrites calls in the test file
// itself, so vi.doMock is used instead - callers must invoke it before
// their dynamic imports.

import { vi } from "vitest";

export function mockIpc(invokeMock) {
  vi.doMock("../../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
}

export function mockQuestionUi(qs, renderQuestionUISpy) {
  vi.doMock("../../src/views/sessions/permission-modal/question-ui.ts", () => ({
    extractQuestions: (...a) => qs.extractQuestions(...a),
    formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
    dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
    snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
    isQuestionAnswered: (...a) => qs.isQuestionAnswered(...a),
    renderQuestionUI: (opts) => renderQuestionUISpy(opts),
  }));
}

export function questionPayload(sessionId, id, questionText) {
  return {
    id,
    session_id: sessionId,
    questions: [{ question: questionText, options: [{ label: "A" }, { label: "B" }] }],
  };
}

// showQuestionCard chains several awaits (fetchFreshestAuqDraft -> invoke ->
// its own .then) before renderQuestionUI runs - a macrotask tick clears all
// of them at once instead of guessing the microtask depth.
export function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function makeSentinelBlock(isAuqAnswerBlock) {
  return function sentinelBlock(blocks) {
    // The production predicate, not a literal: the sentinel now carries the
    // answered card's id, so an exact-string match would miss every real block.
    return blocks.find(isAuqAnswerBlock);
  };
}
