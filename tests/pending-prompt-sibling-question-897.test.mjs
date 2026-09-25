// @vitest-environment jsdom

// Regression (todo 897): a session sat in "input needed" for ~90 minutes
// with no answerable card - the reported shape is a BACKGROUNDED session
// (Joe wasn't looking at it the whole time). The daemon (1d4e1815) correctly
// keeps a session's `awaiting` set to "question" until every sibling prompt
// resolves - but gating.ts's `_pendingPrompts` map holds exactly one parked
// entry per session. A second still-open question for the SAME backgrounded
// session used to overwrite that one slot outright, so the older prompt's
// only local pointer vanished while the daemon still held it open - exactly
// "input needed" with nothing left to reach it through (no sidebar-driven
// replay, no reopen).
//
// Scoped to the parked (backgrounded) path only, not the focused/live-show
// branch: a second live arrival while a card is already ON SCREEN is a
// separate, pre-existing, deliberately unchanged path - see
// tests/auq-second-card-answer-delivery.test.mjs (todo 773), which exercises
// exactly two sequential questions on a *focused* session and must keep
// showing the second one directly.
//
// Covers acceptance item 2 of todo 897: with two prompts outstanding from one
// session, both stay reachable, and the session's local pending-prompt
// tracking (the frontend analogue of `awaiting`) clears only once both
// resolve - regardless of which one is answered first.

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

// question-ui.ts owns the real DOM render + activeCard registration; neither
// is needed to prove this bug, and mocking it out keeps the test to pure
// state transitions (no host DOM, no live-poll timers). Only exercised here
// when a parked sibling is explicitly reopened (surfacePending -> showQuestionCard).
const { renderCalls } = vi.hoisted(() => ({ renderCalls: [] }));
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: () => null,
  confirmQuestionRendered: () => {},
  dismissQuestionCard: () => {},
  snapshotActiveCardDraft: () => null,
  renderQuestionUI: (opts) => { renderCalls.push(opts); },
}));

const {
  handleQuestionRequested,
  handlePromptResolved,
  reopenPendingPrompt,
  pendingPromptSessionIds,
} = await import("../src/views/sessions/permission-modal/index.ts");
const { peekPendingPrompt } = await import("../src/views/sessions/permission-modal/gating.ts");

// A fresh session id per test: the sibling queue added for todo 897 lives in
// index.ts's own module-level Map (no test-facing clear function, matching
// production - it's drained by resolution/reopen, never by a reset hook), so
// reusing one session id across tests would leak a prior test's un-drained
// queue entry into the next. None of these ids is ever passed to
// setSelectedSessionId, so isForSelectedSession is false throughout - every
// arrival takes the parked (backgrounded) branch.
let sidCounter = 0;
function nextSessionId() {
  sidCounter += 1;
  return `s-897-${sidCounter}`;
}

function questionPayload(sessionId, id, seq) {
  return { id, session_id: sessionId, seq, questions: [{ question: `Question ${id}?` }] };
}

/** Flush the microtask queue so `showQuestionCard`'s awaited draft fetch (and
 *  its subsequent renderQuestionUI call) has run - it starts synchronously
 *  but is never awaited by its caller (fire-and-forget `void showQuestionCard(...)`). */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  renderCalls.length = 0;
  invokeMock.mockClear();
});

describe("todo 897: two simultaneous questions from one backgrounded session", () => {
  it("a second still-open question does not overwrite the first's parked tracking", () => {
    const SID = nextSessionId();
    const q1 = questionPayload(SID, "q1-a", 1);
    const q2 = questionPayload(SID, "q2-a", 2);

    handleQuestionRequested(q1);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-a");

    // q2 arrives while q1 is still open and parked. Pre-fix this overwrote
    // the session's single park slot outright.
    handleQuestionRequested(q2);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-a"); // still q1 - not clobbered
    expect(renderCalls).toHaveLength(0); // backgrounded the whole time - never shown
  });

  it("answering the newer sibling first leaves the older reachable, and clears only once both resolve", async () => {
    const SID = nextSessionId();
    const q1 = questionPayload(SID, "q1-b", 1);
    const q2 = questionPayload(SID, "q2-b", 2);

    handleQuestionRequested(q1); // parked, slot = q1
    handleQuestionRequested(q2); // queued behind q1's park
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-b");

    // User switches into the chat and opens q2's own transcript card - its
    // tool_use never got a live card of its own while parked.
    const opened = await reopenPendingPrompt(SID, "q2-b");
    await flush();
    expect(opened).toBe(true);
    expect(renderCalls.map((o) => o.id)).toEqual(["q2-b"]);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q2-b"); // q2 now the front slot

    // Answer q2 (the newer one) FIRST.
    handlePromptResolved("q2-b", true);

    // q1 must still be reachable - promoted back into the slot, not lost.
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-b");
    expect(pendingPromptSessionIds().has(SID)).toBe(true); // attention marker still up

    // Only resolving q1 too clears the session's local tracking.
    handlePromptResolved("q1-b", true);
    expect(peekPendingPrompt(SID)).toBeNull();
    expect(pendingPromptSessionIds().has(SID)).toBe(false);
  });

  it("answering the older (front-slot) sibling first promotes the newer one instead of losing it", () => {
    const SID = nextSessionId();
    const q1 = questionPayload(SID, "q1-c", 1);
    const q2 = questionPayload(SID, "q2-c", 2);

    handleQuestionRequested(q1);
    handleQuestionRequested(q2);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-c");

    handlePromptResolved("q1-c", true);

    // q2 must be promoted into the park slot rather than stranded in the queue.
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q2-c");
    expect(pendingPromptSessionIds().has(SID)).toBe(true);

    handlePromptResolved("q2-c", true);
    expect(peekPendingPrompt(SID)).toBeNull();
    expect(pendingPromptSessionIds().has(SID)).toBe(false);
  });
});
