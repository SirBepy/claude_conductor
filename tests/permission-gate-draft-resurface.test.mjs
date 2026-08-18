// @vitest-environment jsdom

// Regression (2026-08-18): resurface.ts's "permission" branch never threaded
// a parked draft into showPermissionCard, unlike "question"'s showQuestionCard.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const renderCalls = [];
const renderQuestionUISpy = vi.fn((opts) => { renderCalls.push(opts); });
import * as qs from "../src/views/sessions/permission-modal/question-state.ts";
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
  snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
  renderQuestionUI: (opts) => renderQuestionUISpy(opts),
}));

const { storePendingPrompt, savePendingPromptDraft, clearPendingPrompt } = await import(
  "../src/views/sessions/permission-modal/gating.ts"
);
const { replayPendingPrompt } = await import("../src/views/sessions/permission-modal/resurface.ts");

const SESSION = "s1";
const QUESTIONS_INPUT = { questions: [{ question: "Tabs or spaces?", options: [{ label: "Tabs" }, { label: "Spaces" }] }] };

function draft(overrides = {}) {
  return {
    freeText: new Map([[0, "typed before switch"]]),
    selections: new Map(),
    activeTab: 0,
    additionalMessage: "",
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  renderCalls.length = 0;
  renderQuestionUISpy.mockClear();
  invokeMock.mockClear();
  qs.setActiveCard(null);
  clearPendingPrompt(SESSION);
});

describe("a question-shaped PERMISSION prompt's draft survives a park/replay round trip", () => {
  it("replayPendingPrompt restores the draft that was saved onto the parked permission entry", async () => {
    storePendingPrompt(SESSION, {
      kind: "permission",
      payload: { id: "perm-1", tool_name: "mcp__cc_conductor__ask_user_question", input: QUESTIONS_INPUT, session_id: SESSION },
    });
    savePendingPromptDraft(SESSION, draft());

    const ok = replayPendingPrompt(SESSION);
    expect(ok).toBe(true);
    // surfacePending's permission branch checks autoAllowIfRemembered first,
    // which is async (an unawaited get_settings round-trip) even though it
    // resolves false here - flush the microtask before the card mounts.
    await Promise.resolve();
    await Promise.resolve();

    expect(renderCalls.length).toBe(1);
    const opts = renderCalls[0];
    expect(opts.initialDraft).toBeDefined();
    expect(opts.initialDraft.freeText.get(0)).toBe("typed before switch");
  });
});
