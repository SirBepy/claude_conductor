// @vitest-environment jsdom
//
// Regression (2026-10-15): opening chat A then switching to chat B before A's
// pending-prompt lookup settled mounted A's question card over chat B. Every
// card path that awaits the daemon before mounting must re-check the selection.

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
const { rehydrateAndReplay, replayPendingPrompt } = await import("../src/views/sessions/permission-modal/resurface.ts");
const { setSelectedSessionId, storePendingPrompt, peekPendingPrompt, clearPendingPrompt } = await import(
  "../src/views/sessions/permission-modal/gating.ts"
);

const QUESTIONS = [{ question: "Pick one?", options: [{ label: "Yes" }, { label: "No" }] }];
const QUESTION_A = { id: "p-a", session_id: "A", questions: QUESTIONS };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  renderCalls.length = 0;
  renderQuestionUISpy.mockClear();
  // A daemon-side draft makes showQuestionCard mount synchronously, so the
  // rehydrate test below proves the guard in rehydrateAndReplay itself.
  getSessionDrafts.mockReset().mockResolvedValue({
    composer: null,
    auq: { prompt_id: "p-a", payload: { freeText: [[0, "typed"]], selections: [], activeTab: 0 }, updated_at: "2026-10-15T00:00:00.000Z" },
    held: [], held_updated_at: null,
  });
  transportCall.mockReset().mockResolvedValue([]);
  invokeMock.mockReset().mockResolvedValue({});
  qs.setActiveCard(null);
  clearPendingPrompt("A");
  clearPendingPrompt("B");
  setSelectedSessionId("A");
});

describe("a prompt card never mounts over a chat opened while its lookup was in flight", () => {
  it("rehydrateAndReplay leaves A's question parked when the user switched to B mid-fetch", async () => {
    const list = deferred();
    transportCall.mockImplementation(() => list.promise);

    const done = rehydrateAndReplay("A");
    setSelectedSessionId("B");
    list.resolve([{ id: "p-a", event: "question-requested", payload: QUESTION_A }]);
    await done;
    await flush();

    expect(renderCalls.length).toBe(0);
    expect(peekPendingPrompt("A")?.payload.id).toBe("p-a");
  });

  it("rehydrateAndReplay still shows the card when the user stayed on A", async () => {
    transportCall.mockResolvedValue([{ id: "p-a", event: "question-requested", payload: QUESTION_A }]);

    await rehydrateAndReplay("A");
    await flush();

    expect(renderCalls.map((c) => c.sessionId)).toEqual(["A"]);
  });

  it("showQuestionCard does not mount when the chat switched during its draft fetch", async () => {
    const drafts = deferred();
    getSessionDrafts.mockImplementation(() => drafts.promise);

    const done = showQuestionCard(QUESTION_A);
    setSelectedSessionId("B");
    drafts.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    await done;

    expect(renderCalls.length).toBe(0);
    expect(peekPendingPrompt("A")?.payload.id).toBe("p-a");
  });

  it("a new chat's placeholder-to-real id promotion mid-fetch still shows its card", async () => {
    const { state } = await import("../src/views/sessions/state.ts");
    state.pendingNewSession = { placeholderId: "pending-1", realId: "A", projectPath: "C:/proj" };
    state.selectedId = "pending-1";
    setSelectedSessionId("pending-1");
    const drafts = deferred();
    getSessionDrafts.mockImplementation(() => drafts.promise);

    const done = showQuestionCard(QUESTION_A);
    // start_session resolved: same chat, now under its real id.
    state.pendingNewSession = null;
    state.selectedId = "A";
    setSelectedSessionId("A");
    drafts.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    await done;

    expect(renderCalls.map((c) => c.sessionId)).toEqual(["A"]);
  });

  it("a replayed permission card re-parks when the chat switched during its rule check", async () => {
    // Question-shaped, so it renders through renderQuestionUI and the spy sees it.
    storePendingPrompt("A", {
      kind: "permission",
      payload: { id: "perm-a", tool_name: "AskUserQuestion", input: { questions: QUESTIONS }, session_id: "A" },
    });

    expect(replayPendingPrompt("A")).toBe(true);
    // autoAllowIfRemembered is awaited even when it resolves false at once.
    setSelectedSessionId("B");
    await flush();

    expect(renderCalls.length).toBe(0);
    expect(peekPendingPrompt("A")?.payload.id).toBe("perm-a");
  });
});
