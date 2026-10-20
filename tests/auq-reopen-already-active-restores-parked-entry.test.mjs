// @vitest-environment jsdom

// Regression: reopenPendingPrompt's already-active no-op guard (resurface.ts,
// added by 96a4de97 for the transcript-card-click flicker fix) takes the
// session's parked entry via `takePendingPrompt` before it can even
// check whether the card is already live on screen. Every other exit path in
// the function either restores a taken-but-unwanted entry or hands it off to
// `surfacePending` (which is what justifies leaving the store empty - the
// card itself becomes the record). The already-active guard did neither: it
// returned early without restoring the entry, so a session whose parked
// prompt genuinely matched the card already on screen lost its only
// pending-prompt pointer for nothing.

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

// question-ui.ts owns the real DOM render; not needed to prove this bug, and
// mocking it out keeps the test to pure state transitions (no host DOM).
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: () => null,
  confirmQuestionRendered: () => {},
  dismissQuestionCard: () => {},
  snapshotActiveCardDraft: () => null,
  renderQuestionUI: () => {},
}));

const { reopenPendingPrompt, setSelectedSessionId } = await import("../src/views/sessions/permission-modal/index.ts");
const { storePendingPrompt, peekPendingPrompt } = await import("../src/views/sessions/permission-modal/gating.ts");
const { setActiveCard } = await import("../src/views/sessions/permission-modal/question-state.ts");

beforeEach(() => {
  invokeMock.mockClear();
  setActiveCard(null);
});

describe("reopenPendingPrompt's already-active no-op restores the parked entry", () => {
  it("leaves the session's pending-prompt slot intact when it no-ops for a card already on screen", async () => {
    const SID = "s-1254-a";
    const CARD_ID = "card-already-active";
    const payload = { id: CARD_ID, session_id: SID, seq: 1, questions: [{ question: "Still open?" }] };

    storePendingPrompt(SID, { kind: "question", payload });
    setSelectedSessionId(SID);
    // The card for CARD_ID is already the one live on screen.
    setActiveCard({ id: CARD_ID, teardown: () => {}, getDraft: () => ({ freeText: "", selection: undefined }) });

    const result = await reopenPendingPrompt(SID, CARD_ID);

    expect(result).toBe(true);
    // Pre-fix: takePendingPrompt already removed this entry and the no-op
    // guard returned early without restoring it, so this read NULLed out.
    expect(peekPendingPrompt(SID)?.payload.id).toBe(CARD_ID);
  });
});
