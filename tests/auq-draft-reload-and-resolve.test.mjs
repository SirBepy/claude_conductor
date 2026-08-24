// @vitest-environment jsdom
//
// Regression coverage for the AUQ draft-loss bugs (2026-08-14) - see each
// `describe` block for the specific repro. `renderQuestionUI` is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getSessionDrafts, setAuqDraft, clearAuqDraft, transportCall, invokeMock } = vi.hoisted(() => ({
  getSessionDrafts: vi.fn(),
  setAuqDraft: vi.fn(),
  clearAuqDraft: vi.fn(),
  transportCall: vi.fn(),
  invokeMock: vi.fn(),
}));
const { renderCalls, renderQuestionUISpy } = vi.hoisted(() => {
  const renderCalls = [];
  return { renderCalls, renderQuestionUISpy: vi.fn((opts) => { renderCalls.push(opts); }) };
});

vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  getSessionDrafts: (...a) => getSessionDrafts(...a),
  setAuqDraft: (...a) => setAuqDraft(...a),
  clearAuqDraft: (...a) => clearAuqDraft(...a),
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

const { showQuestionCard, handlePromptResolved } = await import(
  "../src/views/sessions/permission-modal/index.ts"
);
const { rehydratePendingPrompts } = await import(
  "../src/views/sessions/permission-modal/resurface.ts"
);
const { loadQuestionDraftMeta, saveQuestionDraft } = await import(
  "../src/views/sessions/permission-modal/draft-persistence.ts"
);
const { scheduleAuqPush } = await import(
  "../src/views/sessions/permission-modal/auq-draft-sync.ts"
);
const { peekPendingPrompt, takePendingPrompt, savePendingPromptDraft, clearPendingPrompt } = await import(
  "../src/views/sessions/permission-modal/gating.ts"
);

const QUESTIONS = [{ question: "Pick one?", options: [{ label: "Yes" }, { label: "No" }] }];

function draft(overrides = {}) {
  return {
    freeText: new Map([[0, "typed"]]),
    selections: new Map(),
    activeTab: 0,
    additionalMessage: "",
    attachments: [],
    ...overrides,
  };
}

/** Simulates what the real (mocked-away) renderQuestionUI does on mount:
 *  registers the card so snapshotActiveCardDraft/dismissQuestionCard see it. */
function registerActiveCard(id, sessionId, getDraft) {
  let torn = false;
  const teardown = () => { torn = true; qs.clearActiveCardIfCurrent(teardown); };
  qs.setActiveCard({ id, sessionId, teardown, getDraft });
  return { wasTornDown: () => torn };
}

beforeEach(() => {
  localStorage.clear();
  renderCalls.length = 0;
  renderQuestionUISpy.mockClear();
  getSessionDrafts.mockReset().mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null });
  setAuqDraft.mockReset().mockResolvedValue({ updated_at: "t" });
  clearAuqDraft.mockReset().mockResolvedValue({ cleared: true });
  transportCall.mockReset().mockResolvedValue([]);
  invokeMock.mockReset().mockResolvedValue(undefined);
  qs.setActiveCard(null);
  clearPendingPrompt("s1");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Bug 1: reload precedence must pick the NEWER draft, not just the daemon's", () => {
  it("a fresher local (localStorage) draft beats a staler daemon draft on reload", async () => {
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    saveQuestionDraft("p1", draft({ freeText: new Map([[0, "fresher local answer"]]), activeTab: 1 }));

    getSessionDrafts.mockResolvedValue({
      composer: null,
      auq: {
        prompt_id: "p1",
        payload: { freeText: [[0, "stale daemon answer"]], selections: [], activeTab: 0 },
        updated_at: "2026-08-13T23:59:59.000Z", // 500ms+ before the local save above
      },
      held: [], held_updated_at: null,
    });

    await showQuestionCard({ id: "p1", session_id: "s1", questions: QUESTIONS });

    const opts = renderCalls[0];
    expect(opts.initialDraft.freeText.get(0)).toBe("fresher local answer");
    expect(opts.initialDraft.activeTab).toBe(1);
  });

  it("a NEWER daemon draft (started on another device) beats an older local draft", async () => {
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    saveQuestionDraft("p1", draft({ freeText: new Map([[0, "older local answer"]]), activeTab: 0 }));

    getSessionDrafts.mockResolvedValue({
      composer: null,
      auq: {
        prompt_id: "p1",
        payload: { freeText: [[0, "newer daemon answer"]], selections: [], activeTab: 2 },
        updated_at: "2026-08-14T00:00:05.000Z",
      },
      held: [], held_updated_at: null,
    });

    await showQuestionCard({ id: "p1", session_id: "s1", questions: QUESTIONS });
    const opts = renderCalls[0];
    expect(opts.initialDraft.freeText.get(0)).toBe("newer daemon answer");
    expect(opts.initialDraft.activeTab).toBe(2);
  });

  it("a legacy local draft with no stored timestamp loses to any timestamped remote draft (migration)", async () => {
    localStorage.setItem("auq-draft:v1:p1", JSON.stringify({
      freeText: [[0, "legacy local, no timestamp"]], selections: [], activeTab: 0,
    }));
    getSessionDrafts.mockResolvedValue({
      composer: null,
      auq: { prompt_id: "p1", payload: { freeText: [[0, "daemon answer"]], selections: [], activeTab: 0 }, updated_at: "2026-08-14T00:00:00.000Z" },
      held: [], held_updated_at: null,
    });
    await showQuestionCard({ id: "p1", session_id: "s1", questions: QUESTIONS });
    expect(renderCalls[0].initialDraft.freeText.get(0)).toBe("daemon answer");
  });

  it("a legacy local draft with no stored timestamp still wins when there is no remote draft at all", async () => {
    localStorage.setItem("auq-draft:v1:p1", JSON.stringify({
      freeText: [[0, "legacy local, no timestamp"]], selections: [], activeTab: 0,
    }));
    getSessionDrafts.mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null });
    await showQuestionCard({ id: "p1", session_id: "s1", questions: QUESTIONS });
    expect(renderCalls[0].initialDraft.freeText.get(0)).toBe("legacy local, no timestamp");
  });
});

describe("Bug 2: prompt-resolved must not destroy an in-progress draft", () => {
  it("a non-durable resolve for the id CURRENTLY OPEN does not wipe its localStorage draft (poll-tick race)", () => {
    saveQuestionDraft("p1", draft({ freeText: new Map([[0, "still typing"]]) }));
    const card = registerActiveCard("p1", "s1", () => draft({ freeText: new Map([[0, "still typing"]]) }));

    handlePromptResolved("p1", false);

    expect(loadQuestionDraftMeta("p1")?.draft.freeText.get(0)).toBe("still typing");
    expect(card.wasTornDown()).toBe(false);
  });

  it("a spurious resolve for a DIFFERENT prompt id does not cancel the active card's own pending daemon push", async () => {
    const card = registerActiveCard("p-active", "s1", () => draft({ freeText: new Map([[0, "in progress"]]) }));
    scheduleAuqPush("s1", "p-active", draft({ freeText: new Map([[0, "in progress"]]) }));

    handlePromptResolved("p-OLD-different", true);

    await vi.advanceTimersByTimeAsync(500);
    expect(setAuqDraft).toHaveBeenCalledWith("s1", "p-active", expect.anything());
    expect(card.wasTornDown()).toBe(false);
  });

  it("a genuine (durable) resolve for the currently-open id clears BOTH localStorage and the daemon push", async () => {
    saveQuestionDraft("p1", draft({ freeText: new Map([[0, "answered elsewhere"]]) }));
    const card = registerActiveCard("p1", "s1", () => draft({ freeText: new Map([[0, "answered elsewhere"]]) }));
    scheduleAuqPush("s1", "p1", draft());

    handlePromptResolved("p1", true);

    expect(loadQuestionDraftMeta("p1")).toBeNull();
    expect(card.wasTornDown()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(setAuqDraft).not.toHaveBeenCalled();
  });
});

describe("Bug 3: rehydrate must attach the best available draft, not drop it", () => {
  it("rehydratePendingPrompts attaches the freshest draft to the re-parked prompt", async () => {
    transportCall.mockResolvedValue([
      { id: "p1", event: "question-requested", durable: true,
        payload: { id: "p1", session_id: "s1", questions: QUESTIONS } },
    ]);
    saveQuestionDraft("p1", draft({ freeText: new Map([[0, "typed before reload"]]) }));

    const ok = await rehydratePendingPrompts("s1");
    expect(ok).toBe(true);

    const pending = peekPendingPrompt("s1");
    expect(pending.draft).toBeDefined();
    expect(pending.draft.freeText.get(0)).toBe("typed before reload");
  });
});

describe("Known-good: switching chats and back must not regress", () => {
  it("snapshot -> park -> takePendingPrompt -> showQuestionCard restores the exact draft, including activeTab", async () => {
    const payload = { id: "p1", session_id: "s1", questions: QUESTIONS };
    await showQuestionCard(payload);
    const liveDraft = draft({ freeText: new Map([[0, "yes"], [1, "no"]]), activeTab: 1 });
    registerActiveCard("p1", "s1", () => liveDraft);

    const snap = qs.snapshotActiveCardDraft("s1");
    savePendingPromptDraft("s1", snap);
    qs.dismissQuestionCard();

    const pending = takePendingPrompt("s1");
    await showQuestionCard(pending.payload, pending.draft);

    const opts = renderCalls[renderCalls.length - 1];
    expect(opts.initialDraft.freeText.get(0)).toBe("yes");
    expect(opts.initialDraft.activeTab).toBe(1);
  });
});
