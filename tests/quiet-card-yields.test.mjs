// @vitest-environment jsdom

// A decisions checkup is a quiet daemon card: first real run, two of them fired
// for one sub with nit-level findings, each with a red dot, and one sat in front of
// a "stopped before it finished" card raised the same second, which only showed
// after the checkup was dismissed. Quiet means: no dot, no ring, and behind every
// other card of its chat whatever arrived first.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd) => {
    if (cmd === "get_session_drafts") return Promise.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    return Promise.resolve(undefined);
  }),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { renderCalls, dismissCalls } = vi.hoisted(() => ({ renderCalls: [], dismissCalls: [] }));
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: () => null,
  confirmQuestionRendered: () => {},
  dismissQuestionCard: (id) => { dismissCalls.push(id); },
  snapshotActiveCardDraft: () => null,
  renderQuestionUI: (opts) => { renderCalls.push(opts); },
}));

const { handleQuestionRequested, handlePromptResolved, pendingPromptSessionIds, parkedDisplayIds, queuedQuestionsFor } =
  await import("../src/views/sessions/permission-modal/index.ts");
const { peekPendingPrompt, setSelectedSessionId } = await import("../src/views/sessions/permission-modal/gating.ts");
const { mainChatInfo } = await import("../src/views/sessions/main-chat.ts");
const { createPromptQueue } = await import("../src/views/sessions/permission-modal/prompt-queue.ts");

let n = 0;
const nextId = () => `quiet-main-${++n}`;
const card = (sid, id, seq, extra = {}) => ({
  id, session_id: sid, display_session_id: sid, seq, daemon_card: true,
  questions: [{ question: `Card ${id}?`, header: id, options: [{ label: "Got it" }] }], ...extra,
});
const checkup = (sid, id, seq) => card(sid, id, seq, { quiet: true, card_kind: "subchat_checkup" });
const stall = (sid, id, seq) => card(sid, id, seq, { card_kind: "subchat_stuck" });

const inst = (id, over = {}) => ({
  session_id: id, pid: 1, cwd: "/p/cv", project_id: "p", kind: "interactive", is_remote: false,
  started_at: "2026-11-05T10:00:00Z", transcript_path: null, name: id, ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});

beforeEach(() => {
  renderCalls.length = 0;
  dismissCalls.length = 0;
});

describe("a quiet card asks for no attention", () => {
  it("gets no attention marker and no red dot, but is still parked for the chat", () => {
    const SID = nextId();
    handleQuestionRequested(checkup(SID, "ck-1", 1));
    expect(peekPendingPrompt(SID)?.payload.id).toBe("ck-1");
    expect(pendingPromptSessionIds().has(SID), "no sidebar attention for a quiet card").toBe(false);
    expect(parkedDisplayIds().has(SID), "housekeeping still sees it").toBe(true);
    const main = inst(SID);
    expect(mainChatInfo(main, [main]).askingDots).toBe(0);
  });

  it("a real card beside it still gets the marker and the dot", () => {
    const SID = nextId();
    handleQuestionRequested(checkup(SID, "ck-2", 1));
    handleQuestionRequested(stall(SID, "st-2", 2));
    expect(pendingPromptSessionIds().has(SID)).toBe(true);
    const main = inst(SID);
    expect(mainChatInfo(main, [main]).askingDots).toBe(1);
  });
});

describe("a quiet card yields to every other card of its chat", () => {
  it("a real card arriving after a parked checkup takes the slot and the checkup waits behind it", () => {
    const SID = nextId();
    handleQuestionRequested(checkup(SID, "ck-3", 1));
    handleQuestionRequested(stall(SID, "st-3", 2));
    expect(peekPendingPrompt(SID)?.payload.id).toBe("st-3");
    expect(queuedQuestionsFor(SID).map((q) => q.id)).toEqual(["ck-3"]);
  });

  it("answering the real card brings the checkup up next", () => {
    const SID = nextId();
    handleQuestionRequested(checkup(SID, "ck-4", 1));
    handleQuestionRequested(stall(SID, "st-4", 2));
    handlePromptResolved("st-4", true);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("ck-4");
    expect(pendingPromptSessionIds().has(SID), "and it is quiet again once it is the only one").toBe(false);
  });

  it("a checkup arriving after a real card queues behind it, and a later real card still outranks it", () => {
    const SID = nextId();
    handleQuestionRequested(stall(SID, "st-5", 1));
    handleQuestionRequested(checkup(SID, "ck-5", 2));
    handleQuestionRequested(stall(SID, "st-5b", 3));
    expect(peekPendingPrompt(SID)?.payload.id).toBe("st-5");
    // Queue order is arrival: ck-5, st-5b. The promotion takes the real card first.
    handlePromptResolved("st-5", true);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("st-5b");
    handlePromptResolved("st-5b", true);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("ck-5");
  });

  it("takes a checkup that is on screen off it when a real card arrives for the same chat", async () => {
    const SID = nextId();
    setSelectedSessionId(SID);
    handleQuestionRequested(checkup(SID, "ck-6", 1));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(renderCalls.map((o) => o.id)).toEqual(["ck-6"]);
    handleQuestionRequested(stall(SID, "st-6", 2));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    setSelectedSessionId(null);
    expect(renderCalls.map((o) => o.id)).toEqual(["ck-6", "st-6"]);
    expect(peekPendingPrompt(SID)?.payload.id).toBe("st-6");
    expect(queuedQuestionsFor(SID).map((q) => q.id)).toEqual(["ck-6"]);
  });
});

describe("the prompt queue's yield rule", () => {
  it("promotes the oldest payload that does not yield, and a yielding one only when alone", () => {
    const got = [];
    const q = createPromptQueue((p) => got.push(p.id), { yields: (p) => p.quiet === true });
    q.push("s", { id: "a", quiet: true });
    q.push("s", { id: "b" });
    q.push("s", { id: "c" });
    q.promote("s");
    q.promote("s");
    q.promote("s");
    expect(got).toEqual(["b", "c", "a"]);
  });

  it("is plain first-in first-out without the option", () => {
    const got = [];
    const q = createPromptQueue((p) => got.push(p.id));
    q.push("s", { id: "a", quiet: true });
    q.push("s", { id: "b" });
    q.promote("s");
    q.promote("s");
    expect(got).toEqual(["a", "b"]);
  });
});
