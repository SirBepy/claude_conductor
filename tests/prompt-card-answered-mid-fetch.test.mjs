// @vitest-environment jsdom
//
// Regression (2026-10-21): after being offline, opening a chat fetched the
// daemon's pending prompts slowly; the live card appeared, the user answered
// it, then the pre-answer snapshot landed and re-parked and re-showed the same
// question. A settled question must never be re-surfaced by a stale fetch.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { transportCall } = vi.hoisted(() => ({ transportCall: vi.fn() }));
const { renderCalls } = vi.hoisted(() => ({ renderCalls: [] }));

vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  getSessionDrafts: vi.fn().mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null }),
  setAuqDraft: vi.fn().mockResolvedValue({ updated_at: "t" }),
  clearAuqDraft: vi.fn().mockResolvedValue({ cleared: true }),
}));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({ call: (...a) => transportCall(...a), listen: vi.fn() }),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn().mockResolvedValue({}) }));

import * as qs from "../src/views/sessions/permission-modal/question-state.ts";

vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  isQuestionAnswered: (...a) => qs.isQuestionAnswered(...a),
  snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
  renderQuestionUI: (opts) => { renderCalls.push(opts); },
}));

const { rehydrateAndReplay } = await import("../src/views/sessions/permission-modal/resurface.ts");
const { setSelectedSessionId, storePendingPrompt, peekPendingPrompt, clearPendingPrompt, markPendingPromptAnswered } =
  await import("../src/views/sessions/permission-modal/gating.ts");

const QUESTIONS = [{ question: "Pick one?", options: [{ label: "Yes" }, { label: "No" }] }];
const Q = { id: "p-settled", session_id: "A", questions: QUESTIONS };

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
  transportCall.mockReset().mockResolvedValue([]);
  qs.setActiveCard(null);
  clearPendingPrompt("A");
  setSelectedSessionId("A");
});

describe("a stale pending-prompt fetch never resurrects a settled question", () => {
  it("a question answered while the fetch was in flight is not shown again", async () => {
    const list = deferred();
    transportCall.mockImplementation(() => list.promise);

    const done = rehydrateAndReplay("A");
    storePendingPrompt("A", { kind: "question", payload: Q });
    markPendingPromptAnswered("A", Q.id);
    clearPendingPrompt("A"); // prompt-resolved poll cleared the slot
    list.resolve([{ id: Q.id, event: "question-requested", payload: Q }]);
    await done;
    await flush();

    expect(renderCalls.length).toBe(0);
    expect(peekPendingPrompt("A")).toBeNull();
  });

  it("a card already parked by the live event is not replaced by the fetch result", async () => {
    const list = deferred();
    transportCall.mockImplementation(() => list.promise);

    const done = rehydrateAndReplay("A");
    storePendingPrompt("A", { kind: "question", payload: { ...Q, id: "p-live" } });
    list.resolve([{ id: "p-live", event: "question-requested", payload: { ...Q, id: "p-live" } }]);
    await done;
    await flush();

    expect(renderCalls.length).toBe(0);
    expect(peekPendingPrompt("A")?.payload.id).toBe("p-live");
  });
});
