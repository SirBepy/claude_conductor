// @vitest-environment jsdom

// Regression (todo 971): two question blocks arriving in ONE assistant turn
// on a FOCUSED session must not clobber each other. Todo 897 (c905f41c) fixed
// this shape for a BACKGROUNDED/parked session only - see that commit's own
// sibling-queue comment in index.ts. Before this fix, handleQuestionRequested's
// focused branch called showQuestionCard unconditionally for every arrival, so
// a second still-open question replaced the first's only pending-prompt slot
// immediately, on screen, before the user ever answered it - dropping the
// first prompt from all local tracking while the daemon still held it open
// (same "input needed" shape as 897, just reachable with the chat foregrounded
// instead of AFK).
//
// Distinguishing a genuine open sibling from a slot that's ALREADY answered
// but not yet cleared by the daemon's `prompt-resolved` poll (the case
// tests/auq-second-card-answer-delivery.test.mjs exercises, todo 773) is the
// actual blocker 897 left open. Fixed per todo 971's option 1: mark the slot
// answered at onSubmit time, so the sibling gate can be made session-agnostic
// without touching that guard.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { renderCalls } = vi.hoisted(() => ({ renderCalls: [] }));
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
// state transitions (no host DOM, no live-poll timers) - same approach as
// tests/pending-prompt-sibling-question-897.test.mjs.
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: () => null,
  confirmQuestionRendered: () => {},
  dismissQuestionCard: () => {},
  snapshotActiveCardDraft: () => null,
  isQuestionAnswered: () => true,
  formatAnswersAsMessage: () => "answer-text",
  renderQuestionUI: (opts) => { renderCalls.push(opts); },
}));

const {
  handleQuestionRequested,
  handlePromptResolved,
  reopenPendingPrompt,
  pendingPromptSessionIds,
  setSelectedSessionId,
} = await import("../src/views/sessions/permission-modal/index.ts");
const { peekPendingPrompt } = await import("../src/views/sessions/permission-modal/gating.ts");
const { state } = await import("../src/views/sessions/state.ts");

// A fresh session id AND fresh prompt ids per test: the sibling queue (todo
// 897), the answered marker (todo 971), and the pending-prompt map itself all
// live in module-level state with no test-facing reset hook, matching
// production (drained by resolution/reopen, never a reset). `findSessionForPendingId`
// / `clearPendingPromptById` scan ACROSS every session by id, so reusing a
// literal id like "q1" across test cases would let a later test's resolve
// match a prior test's un-drained leftover for a DIFFERENT session.
let sidCounter = 0;
function nextSessionId() {
  sidCounter += 1;
  return `s-971-${sidCounter}`;
}

function questionPayload(sessionId, id, seq) {
  return { id, session_id: sessionId, seq, questions: [{ question: `Question ${id}?` }] };
}

/** Flush the microtask queue so showQuestionCard's awaited draft fetch (and
 *  its subsequent renderQuestionUI call) has run - it starts synchronously
 *  but is never awaited by its caller (fire-and-forget `void showQuestionCard(...)`). */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function focusSession(sid) {
  state.sessions = [{ session_id: sid }];
  state.selectedId = sid;
  state.pendingNewSession = null;
  setSelectedSessionId(sid);
}

beforeEach(() => {
  renderCalls.length = 0;
  invokeMock.mockClear();
});

describe("todo 971: two question blocks in one turn on a focused session", () => {
  it("a second still-open question does not clobber the first's slot while both are unanswered", async () => {
    const SID = nextSessionId();
    focusSession(SID);
    const q1 = questionPayload(SID, "q1-a", 1);
    const q2 = questionPayload(SID, "q2-a", 2);

    handleQuestionRequested(q1);
    await flush();
    expect(renderCalls.map((o) => o.id)).toEqual(["q1-a"]);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-a");

    // q2 arrives in the SAME turn, while q1 is still open and on screen - the
    // bug: this used to render q2 immediately, clobbering q1's only
    // pending-prompt pointer even though nobody had answered it yet.
    handleQuestionRequested(q2);
    await flush();
    expect(renderCalls.map((o) => o.id)).toEqual(["q1-a"]); // still just q1 shown
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-a"); // not clobbered
    expect(pendingPromptSessionIds().has(SID)).toBe(true);

    // q2 must still be reachable, via its own transcript card.
    const opened = await reopenPendingPrompt(SID, "q2-a");
    await flush();
    expect(opened).toBe(true);
    expect(renderCalls.map((o) => o.id)).toEqual(["q1-a", "q2-a"]);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q2-a");
  });

  it("answering q1 via onSubmit (slot stale, poll not yet run) still lets a genuinely new q2 render immediately", async () => {
    // Mirrors auq-second-card-answer-delivery.test.mjs (todo 773): answer q1
    // fully via onSubmit with no prompt-resolved poll simulated, then a new
    // q2 arrives. The slot must not be read as "an open sibling" just because
    // the daemon's resolve poll hasn't run yet - this is the exact ambiguity
    // todo 971's option 1 (mark-answered-at-onSubmit) resolves.
    const SID = nextSessionId();
    focusSession(SID);
    const q1 = questionPayload(SID, "q1-b", 1);

    handleQuestionRequested(q1);
    await flush();
    expect(renderCalls).toHaveLength(1);
    await renderCalls[0].onSubmit({ "Question q1-b?": "A" }, { additionalMessage: "", attachments: [] });
    // Slot still holds q1 - the resolve poll was never simulated, same as 773.
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-b");

    const q2 = questionPayload(SID, "q2-b", 2);
    handleQuestionRequested(q2);
    await flush();
    expect(renderCalls.map((o) => o.id)).toEqual(["q1-b", "q2-b"]); // q2 rendered immediately, not queued
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q2-b");
  });

  it("the session's local tracking clears only once both siblings resolve", async () => {
    const SID = nextSessionId();
    focusSession(SID);
    const q1 = questionPayload(SID, "q1-c", 1);
    const q2 = questionPayload(SID, "q2-c", 2);

    handleQuestionRequested(q1);
    await flush();
    handleQuestionRequested(q2); // queued behind the still-open q1
    await flush();
    expect(pendingPromptSessionIds().has(SID)).toBe(true);

    // Resolve q1 (the front slot) durably - q2 must be promoted, not lost.
    handlePromptResolved("q1-c", true);
    await flush();
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q2-c");
    expect(pendingPromptSessionIds().has(SID)).toBe(true); // q2 still open

    // Resolve q2 too - only now does the session's tracking clear.
    handlePromptResolved("q2-c", true);
    expect(peekPendingPrompt(SID)).toBeNull();
    expect(pendingPromptSessionIds().has(SID)).toBe(false);
  });
});

// Regression (todo 975): resurface.ts's `reopenPendingPrompt` swap branch
// re-queues a slot it displaces via `queueSiblingQuestion(sessionId,
// displaced.payload)` - `.payload` only. Todo 971's `answered` flag (set
// synchronously at onSubmit/onCancel, before the daemon's `prompt-resolved`
// poll has caught up) lives on the PendingPrompt, not the payload, so it was
// dropped on the way into the sibling queue. If the displaced prompt is later
// promoted back out (its temporary occupant resolving), it re-entered
// handleQuestionRequested with no memory of having been answered and
// rendered as a fresh, open card.
describe("todo 975: a displaced answered prompt must not resurface as open", () => {
  it("submit A, reopen B's own card while A's slot is stale, then promote A back out via B resolving - A must not re-render", async () => {
    const SID = nextSessionId();
    focusSession(SID);
    const q1 = questionPayload(SID, "q1-d", 1);
    const q2 = questionPayload(SID, "q2-d", 2);

    // A arrives and is shown; B arrives in the same turn and queues behind it.
    handleQuestionRequested(q1);
    await flush();
    handleQuestionRequested(q2);
    await flush();
    expect(renderCalls.map((o) => o.id)).toEqual(["q1-d"]);

    // Submit A. The slot still holds A (answered=true) - the resolve poll
    // was never simulated, same staleness window as todo 971's own test above.
    await renderCalls[0].onSubmit({ "Question q1-d?": "A" }, { additionalMessage: "", attachments: [] });
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q1-d");

    // User reopens B's own transcript card while A's stale-but-answered
    // record still occupies the slot. reopenPendingPrompt's swap branch
    // displaces A to make room for B.
    const opened = await reopenPendingPrompt(SID, "q2-d");
    await flush();
    expect(opened).toBe(true);
    expect(renderCalls.map((o) => o.id)).toEqual(["q1-d", "q2-d"]);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("q2-d");

    // B resolves durably, freeing the slot and promoting whatever the swap
    // branch displaced - which must NOT be A rendered as a fresh open card,
    // because A was already submitted.
    handlePromptResolved("q2-d", true);
    await flush();
    expect(renderCalls.map((o) => o.id)).toEqual(["q1-d", "q2-d"]); // A did not re-render
    expect(peekPendingPrompt(SID)).toBeNull(); // nothing left to promote as "open"
  });
});
