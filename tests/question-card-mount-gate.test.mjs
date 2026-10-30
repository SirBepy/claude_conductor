// @vitest-environment jsdom
//
// showQuestionCard is the one place a question card is mounted. Each caller
// checks the selection at its own moment, but a caller that checked before an
// await of its own and then calls in after the user moved on hands this
// function a payload for a chat that is no longer on screen. The card must not
// mount over the chat now shown, and the question must stay parked so it
// appears when its own chat is opened again.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionDrafts, transportCall, invokeMock } = vi.hoisted(() => ({
  getSessionDrafts: vi.fn(),
  transportCall: vi.fn(),
  invokeMock: vi.fn(),
}));
const { renderCalls, renderQuestionUISpy } = vi.hoisted(() => {
  const renderCalls = [];
  return { renderCalls, renderQuestionUISpy: vi.fn((opts) => { renderCalls.push(opts); }) };
});

vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  getSessionDrafts: (...a) => getSessionDrafts(...a),
  setAuqDraft: vi.fn().mockResolvedValue({ updated_at: "t" }),
  clearAuqDraft: vi.fn().mockResolvedValue({ cleared: true }),
}));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({ call: (...a) => transportCall(...a), listen: vi.fn() }),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

import * as qs from "../src/views/sessions/permission-modal/question-state.ts";

vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  isQuestionAnswered: (...a) => qs.isQuestionAnswered(...a),
  snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
  renderQuestionUI: (opts) => renderQuestionUISpy(opts),
}));

const { showQuestionCard } = await import("../src/views/sessions/permission-modal/index.ts");
const { replayPendingPrompt } = await import("../src/views/sessions/permission-modal/resurface.ts");
const { setSelectedSessionId, peekPendingPrompt, clearPendingPrompt } = await import(
  "../src/views/sessions/permission-modal/gating.ts"
);
const { state } = await import("../src/views/sessions/state.ts");

const QUESTIONS = [{ question: "Pick one?", options: [{ label: "Yes" }, { label: "No" }] }];
const QUESTION_A = { id: "p-a", session_id: "A", questions: QUESTIONS };

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  renderCalls.length = 0;
  renderQuestionUISpy.mockClear();
  getSessionDrafts.mockReset().mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null });
  transportCall.mockReset().mockResolvedValue([{ id: "p-a", event: "question-requested", payload: QUESTION_A }]);
  invokeMock.mockReset().mockResolvedValue({});
  qs.setActiveCard(null);
  clearPendingPrompt("A");
  clearPendingPrompt("B");
  state.pendingNewSession = null;
});

describe("showQuestionCard only mounts for the chat on screen", () => {
  it("does not mount a card for chat A while B is selected, and keeps A's question parked", async () => {
    setSelectedSessionId("B");

    await showQuestionCard(QUESTION_A);
    await flush();

    expect(renderCalls.length).toBe(0);
    expect(peekPendingPrompt("A")?.payload.id).toBe("p-a");
  });

  it("shows the parked card once its own chat is selected", async () => {
    setSelectedSessionId("B");
    await showQuestionCard(QUESTION_A);

    setSelectedSessionId("A");
    expect(replayPendingPrompt("A")).toBe(true);
    await flush();

    expect(renderCalls.map((c) => c.sessionId)).toEqual(["A"]);
  });

  it("mounts for the selected chat", async () => {
    setSelectedSessionId("A");

    await showQuestionCard(QUESTION_A);

    expect(renderCalls.map((c) => c.sessionId)).toEqual(["A"]);
  });

  it("mounts for a brand-new chat whose placeholder is still the selected id", async () => {
    state.pendingNewSession = { placeholderId: "pending-1", realId: "A", projectPath: "C:/proj" };
    state.selectedId = "pending-1";
    setSelectedSessionId("pending-1");

    await showQuestionCard(QUESTION_A);

    expect(renderCalls.map((c) => c.sessionId)).toEqual(["A"]);
  });
});
