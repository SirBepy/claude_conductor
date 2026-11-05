// @vitest-environment jsdom

// Subchats: a hidden sub asks, but Joe answers in the main chat's window. The
// daemon stamps each prompt with `display_session_id` (the main chat) while
// `session_id` stays the asker and the answer target. Mocks only the DOM-heavy
// renderQuestionUI, like the other permission-modal tests; the card itself is
// driven by e2e/view-harness/subchat-question-routing.view.spec.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, transportCall } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd) => {
    if (cmd === "get_session_drafts") {
      return Promise.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    }
    return Promise.resolve(undefined);
  }),
  transportCall: vi.fn(),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({ call: (...a) => transportCall(...a), listen: vi.fn() }),
  isRemote: () => false,
}));
vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  getSessionDrafts: vi.fn().mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null }),
  setAuqDraft: vi.fn().mockResolvedValue({ updated_at: "t" }),
  clearAuqDraft: vi.fn().mockResolvedValue({ cleared: true }),
}));

const { renderCalls } = vi.hoisted(() => ({ renderCalls: [] }));
import * as qs from "../src/views/sessions/permission-modal/question-state.ts";
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
  snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
  isQuestionAnswered: (...a) => qs.isQuestionAnswered(...a),
  confirmQuestionRendered: (id, sessionId) => invokeMock("confirm_question_rendered", { id, sessionId }),
  renderQuestionUI: (opts) => { renderCalls.push(opts); },
}));
const showPermissionCardSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/views/sessions/permission-modal/permission-card.ts", () => ({
  showPermissionCard: (...a) => showPermissionCardSpy(...a),
  showQuestionReplay: () => {},
}));

const idx = await import("../src/views/sessions/permission-modal/index.ts");
const gating = await import("../src/views/sessions/permission-modal/gating.ts");
const askers = await import("../src/views/sessions/permission-modal/askers.ts");
const submit = await import("../src/views/sessions/permission-modal/question-submit.ts");
const { state } = await import("../src/views/sessions/state.ts");

let n = 0;
const fresh = (p) => `${p}-${++n}`;
const qn = (count) => Array.from({ length: count }, (_, i) => ({ question: `Q${i + 1}?`, options: [{ label: "A" }, { label: "B" }] }));
const subQ = (main, sub, id, count = 1, extra = {}) => ({
  id, session_id: sub, display_session_id: main, sub_name: `name-${sub}`, seq: ++n, questions: qn(count), ...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const sent = (cmd) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

function listen(sessions) {
  state.sessions = sessions.map((id) => ({ session_id: id }));
}

beforeEach(() => {
  renderCalls.length = 0;
  invokeMock.mockClear();
  transportCall.mockReset().mockResolvedValue([]);
  showPermissionCardSpy.mockClear();
  qs.setActiveCard(null);
  gating.setSelectedSessionId(null);
  state.sessions = [];
});

describe("where a sub's question shows", () => {
  it("mounts on the MAIN chat's window, answering to the sub", async () => {
    const main = fresh("main"); const sub = fresh("sub");
    listen([main, sub]);
    gating.setSelectedSessionId(main);
    idx.handleQuestionRequested(subQ(main, sub, "q1"));
    await flush();
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].sessionId).toBe(sub);
    expect(renderCalls[0].displayId).toBe(main);
    expect(renderCalls[0].from).toEqual({ name: `name-${sub}`, task: undefined });
  });

  it("parks under the sub and marks the MAIN chat's row, not the sub's", () => {
    const main = fresh("main"); const sub = fresh("sub");
    listen([main, sub]);
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested(subQ(main, sub, "q1"));
    expect(renderCalls).toHaveLength(0);
    expect(gating.peekPendingPrompt(sub)?.payload.id).toBe("q1");
    expect(gating.pendingPromptSessionIds()).toContain(main);
    expect(gating.pendingPromptSessionIds()).not.toContain(sub);
  });

  it("a prompt with no display id (older daemon, Jarvis worker) routes by its asker, exactly as before", async () => {
    const worker = fresh("worker");
    listen([worker]);
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested({ id: "w1", session_id: worker, seq: 1, questions: qn(1) });
    expect(gating.pendingPromptSessionIds()).toContain(worker);
    gating.setSelectedSessionId(worker);
    gating.clearPendingPrompt(worker);
    idx.handleQuestionRequested({ id: "w2", session_id: worker, display_session_id: worker, seq: 2, questions: qn(1) });
    await flush();
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].from).toBeUndefined();
  });

  it("closing the main chat's row sweeps its subs' parked cards, a live main chat keeps them", () => {
    const main = fresh("main"); const sub = fresh("sub");
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested(subQ(main, sub, "q1"));
    // The sidebar sweep walks display ids and clears the ones whose row is gone.
    for (const id of gating.pendingPromptSessionIds()) if (id !== main) gating.clearPendingPrompt(id);
    expect(gating.peekPendingPrompt(sub)).not.toBeNull();
    gating.clearPendingPrompt(main);
    expect(gating.peekPendingPrompt(sub)).toBeNull();
  });
});

describe("delivery truth", () => {
  it("a sub question parked with no row to mark is NOT confirmed delivered", () => {
    const main = fresh("main"); const sub = fresh("sub");
    listen([sub]); // the main chat has no row: nothing could ever show the card
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested(subQ(main, sub, "q1"));
    expect(sent("confirm_question_rendered")).toHaveLength(0);
  });

  it("a sub question parked on a main chat that has a row IS confirmed", () => {
    const main = fresh("main"); const sub = fresh("sub");
    listen([main, sub]);
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested(subQ(main, sub, "q1"));
    expect(sent("confirm_question_rendered")).toEqual([{ id: "q1", sessionId: sub }]);
  });

  it("a normal chat's parked question is confirmed as it always was, even with no session row", () => {
    const solo = fresh("solo");
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested({ id: "n1", session_id: solo, seq: 1, questions: qn(1) });
    expect(sent("confirm_question_rendered")).toEqual([{ id: "n1", sessionId: solo }]);
  });
});

describe("permission prompts from a sub", () => {
  const perm = (main, sub, id) => ({
    id, tool_name: "Bash", input: { command: "ls" }, session_id: sub, display_session_id: main, sub_name: "s",
  });

  it("is not auto-approved by the MAIN chat's auto-accept, and shows on the main chat", async () => {
    const main = fresh("main"); const sub = fresh("sub");
    listen([main, sub]);
    gating.setAutoAccept(main, true);
    gating.setSelectedSessionId(main);
    invokeMock.mockClear();
    idx.handlePermissionRequested(perm(main, sub, "p1"));
    await flush();
    expect(sent("respond_permission")).toHaveLength(0);
    expect(showPermissionCardSpy).toHaveBeenCalledTimes(1);
    expect(showPermissionCardSpy.mock.calls[0][0].id).toBe("p1");
    gating.setAutoAccept(main, false);
  });

  it("is not auto-approved by the main chat's auto-accept while Joe is in another chat either", async () => {
    const main = fresh("main"); const sub = fresh("sub");
    listen([main, sub]);
    gating.setAutoAccept(main, true);
    gating.setSelectedSessionId("somewhere-else");
    invokeMock.mockClear();
    idx.handlePermissionRequested(perm(main, sub, "p3"));
    await flush();
    expect(sent("respond_permission")).toHaveLength(0);
    expect(gating.peekPendingPrompt(sub)?.kind).toBe("permission");
    expect(gating.pendingPromptSessionIds()).toContain(main);
    gating.setAutoAccept(main, false);
  });

  it("is auto-approved when the SUB itself is on auto-accept", async () => {
    const main = fresh("main"); const sub = fresh("sub");
    listen([main, sub]);
    gating.setAutoAccept(sub, true);
    gating.setSelectedSessionId(main);
    invokeMock.mockClear();
    idx.handlePermissionRequested(perm(main, sub, "p2"));
    await flush();
    expect(sent("respond_permission")).toEqual([
      expect.objectContaining({ id: "p2", sessionId: sub, behavior: "allow" }),
    ]);
    expect(showPermissionCardSpy).not.toHaveBeenCalled();
    gating.setAutoAccept(sub, false);
  });
});

describe("the asker picker", () => {
  it("lists the main chat and each sub, fewest questions first, only when more than one asker has something open", () => {
    const main = fresh("main"); const a = fresh("a"); const b = fresh("b");
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested(subQ(main, a, "qa", 3));
    expect(askers.askerChips(main, a)).toBeNull();
    idx.handleQuestionRequested(subQ(main, b, "qb", 1));
    idx.handleQuestionRequested({ id: "qm", session_id: main, seq: ++n, questions: qn(2) });
    const chips = askers.askerChips(main, b);
    expect(chips.map((c) => [c.askerId, c.count, c.isMain])).toEqual([[b, 1, false], [main, 2, true], [a, 3, false]]);
    expect(chips.find((c) => c.active)?.askerId).toBe(b);
  });

  it("keeps the order stable while a card is open and slots a newcomer in by its own count", () => {
    const main = fresh("main"); const a = fresh("a"); const b = fresh("b"); const c = fresh("c");
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested(subQ(main, a, "qa", 2));
    idx.handleQuestionRequested(subQ(main, b, "qb", 3));
    expect(askers.askerChips(main, a).map((x) => x.askerId)).toEqual([a, b]);
    idx.handleQuestionRequested(subQ(main, c, "qc", 1));
    // c has the fewest, so it leads; a and b keep their relative order.
    expect(askers.askerChips(main, a).map((x) => x.askerId)).toEqual([c, a, b]);
    // A sibling raising a's count past b's does not reshuffle chips Joe is looking at.
    idx.handleQuestionRequested(subQ(main, a, "qa2", 5));
    expect(askers.askerChips(main, a).map((x) => x.askerId)).toEqual([c, a, b]);
  });

  it("replays the fewest-question asker first when the main chat is opened", async () => {
    const main = fresh("main"); const a = fresh("a"); const b = fresh("b");
    listen([main, a, b]);
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested(subQ(main, a, "qa", 3));
    idx.handleQuestionRequested(subQ(main, b, "qb", 1));
    gating.setSelectedSessionId(main);
    transportCall.mockResolvedValue([
      { id: "qa", event: "question-requested", payload: subQ(main, a, "qa", 3) },
      { id: "qb", event: "question-requested", payload: subQ(main, b, "qb", 1) },
    ]);
    expect(idx.replayPendingPrompt(main)).toBe(true);
    await flush();
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].sessionId).toBe(b);
    // The one not shown stays parked, and the picker offers it.
    expect(gating.peekPendingPrompt(a)?.payload.id).toBe("qa");
    expect(renderCalls[0].askers().map((x) => x.askerId)).toEqual([b, a]);
  });
});

describe("answering and skipping a sub's card", () => {
  // A fresh prompt id per card: answered ids are remembered for the page's lifetime.
  async function mountSubCard(main, sub, id = fresh("q")) {
    listen([main, sub]);
    gating.setSelectedSessionId(main);
    idx.handleQuestionRequested(subQ(main, sub, id, 1, { sub_task: "Fix the login test" }));
    await flush();
    return renderCalls.at(-1);
  }

  it("the answer goes to the sub and never to the main chat", async () => {
    const main = fresh("main"); const sub = fresh("sub");
    const opts = await mountSubCard(main, sub);
    expect(opts.from).toEqual({ name: `name-${sub}`, task: "Fix the login test" });
    await opts.onSubmit({ "Q1?": "A" }, { additionalMessage: "", attachments: [] });
    const sends = sent("send_message");
    expect(sends).toHaveLength(1);
    expect(sends[0].sessionId).toBe(sub);
    expect(sends.some((s) => s.sessionId === main)).toBe(false);
    expect(sent("respond_question")[0]).toMatchObject({ id: opts.id, skipped: false });
  });

  it("Skip on a sub's card tells the sub, in the exact words", async () => {
    const main = fresh("main"); const sub = fresh("sub");
    const opts = await mountSubCard(main, sub);
    await opts.onCancel();
    expect(sent("respond_question")[0]).toMatchObject({ id: opts.id, skipped: true });
    const sends = sent("send_message");
    expect(sends).toHaveLength(1);
    expect(sends[0].sessionId).toBe(sub);
    expect(sends[0].blocks).toEqual([{
      type: "text",
      text: "Joe skipped this. Pick the safest default, or finish and report it as blocked.",
    }]);
    expect(submit.SUB_SKIP_MESSAGE).toBe(sends[0].blocks[0].text);
  });

  it("Skip on a normal chat's card sends nothing", async () => {
    const solo = fresh("solo");
    listen([solo]);
    gating.setSelectedSessionId(solo);
    const nid = fresh("n");
    idx.handleQuestionRequested({ id: nid, session_id: solo, seq: 1, questions: qn(1) });
    await flush();
    await renderCalls.at(-1).onCancel();
    expect(sent("respond_question")[0]).toMatchObject({ id: nid, skipped: true });
    expect(sent("send_message")).toHaveLength(0);
  });

  it("answering one asker brings the other's card up on its own", async () => {
    const main = fresh("main"); const a = fresh("a"); const b = fresh("b");
    listen([main, a, b]);
    gating.setSelectedSessionId("somewhere-else");
    idx.handleQuestionRequested(subQ(main, a, "qa", 1));
    idx.handleQuestionRequested(subQ(main, b, "qb", 2));
    gating.setSelectedSessionId(main);
    transportCall.mockResolvedValue([
      { id: "qa", event: "question-requested", payload: subQ(main, a, "qa", 1) },
      { id: "qb", event: "question-requested", payload: subQ(main, b, "qb", 2) },
    ]);
    idx.replayPendingPrompt(main);
    await flush();
    const first = renderCalls.at(-1);
    expect(first.sessionId).toBe(a);
    // submit() has already torn the card down when onSubmit runs.
    await first.onSubmit({ "Q1?": "A" }, { additionalMessage: "", attachments: [] });
    await flush();
    expect(renderCalls.at(-1).sessionId).toBe(b);
  });

  describe("a Skip on a sub that is mid-turn", () => {
    it("reaches the sub through the daemon's held list when no chat composer is mounted", async () => {
      const main = fresh("main"); const sub = fresh("sub");
      const opts = await mountSubCard(main, sub);
      const normal = invokeMock.getMockImplementation();
      invokeMock.mockImplementation((cmd, ...rest) =>
        cmd === "send_message" ? Promise.reject(new Error("SESSION_BUSY: sub is mid-turn")) : normal(cmd, ...rest));
      const savedHeld = state.heldMessages;
      state.heldMessages = null; // the dashboard page: no chat composer, so no held-message queue object
      try {
        await opts.onCancel();
      } finally {
        state.heldMessages = savedHeld;
        invokeMock.mockImplementation(normal);
      }
      expect(sent("add_held_message")).toEqual([{ sessionId: sub, blocks: [{ type: "text", text: submit.SUB_SKIP_MESSAGE }] }]);
      expect(document.body.textContent).not.toContain("Skip notice failed");
    });

    it("goes onto the open composer's queue when there is one, and not onto the daemon's twice", async () => {
      const main = fresh("main"); const sub = fresh("sub");
      const opts = await mountSubCard(main, sub);
      const normal = invokeMock.getMockImplementation();
      invokeMock.mockImplementation((cmd, ...rest) =>
        cmd === "send_message" ? Promise.reject(new Error("SESSION_BUSY: x")) : normal(cmd, ...rest));
      const stageFor = vi.fn(() => true);
      const savedHeld = state.heldMessages;
      state.heldMessages = { stageFor };
      try {
        await opts.onCancel();
      } finally {
        state.heldMessages = savedHeld;
        invokeMock.mockImplementation(normal);
      }
      expect(stageFor).toHaveBeenCalledTimes(1);
      expect(sent("add_held_message")).toHaveLength(0);
    });
  });

  describe("a permission prompt that arrives behind another asker's open card", () => {
    const perm = (main, asker, id) => ({
      id, tool_name: "Bash", input: { command: "ls" }, session_id: asker, display_session_id: main, sub_name: `name-${asker}`,
    });
    const cardUp = (id, asker, main) =>
      qs.setActiveCard({ id, sessionId: asker, displayId: main, teardown: () => {}, getDraft: () => ({}), expand: () => true });

    it("is held back instead of tearing the question card down, and is offered in the picker", async () => {
      const main = fresh("main"); const a = fresh("a"); const b = fresh("b"); const qa = fresh("qa");
      listen([main, a, b]);
      gating.setSelectedSessionId(main);
      idx.handleQuestionRequested(subQ(main, a, qa, 2));
      await flush();
      cardUp(qa, a, main);
      idx.handlePermissionRequested(perm(main, b, "pb"));
      await flush();
      expect(showPermissionCardSpy).not.toHaveBeenCalled();
      expect(gating.peekPendingPrompt(b)?.kind).toBe("permission");
      const chips = askers.askerChips(main, a);
      expect(chips.map((c) => [c.askerId, c.blocking === true])).toEqual([[b, true], [a, false]]);
      expect(chips.find((c) => c.askerId === a)?.active).toBe(true);
    });

    it("shows once the card in front is done", async () => {
      const main = fresh("main"); const a = fresh("a"); const b = fresh("b"); const qa = fresh("qa");
      listen([main, a, b]);
      gating.setSelectedSessionId(main);
      idx.handleQuestionRequested(subQ(main, a, qa, 1));
      await flush();
      cardUp(qa, a, main);
      idx.handlePermissionRequested(perm(main, b, "pb"));
      await flush();
      expect(showPermissionCardSpy).not.toHaveBeenCalled();
      // Joe answers a's card: it is torn down before onSubmit runs.
      qs.setActiveCard(null);
      await renderCalls.at(-1).onSubmit({ "Q1?": "A" }, { additionalMessage: "", attachments: [] });
      await flush();
      expect(showPermissionCardSpy).toHaveBeenCalledTimes(1);
      expect(showPermissionCardSpy.mock.calls[0][0].id).toBe("pb");
    });

    it("picking its chip brings it up and leaves the question's slot and draft to come back", async () => {
      const main = fresh("main"); const a = fresh("a"); const b = fresh("b"); const qa = fresh("qa");
      listen([main, a, b]);
      gating.setSelectedSessionId(main);
      idx.handleQuestionRequested(subQ(main, a, qa, 2));
      await flush();
      const questionOpts = renderCalls.at(-1);
      cardUp(qa, a, main);
      idx.handlePermissionRequested(perm(main, b, "pb"));
      await flush();
      expect(showPermissionCardSpy).not.toHaveBeenCalled();
      questionOpts.onPickAsker(b);
      await flush();
      expect(showPermissionCardSpy).toHaveBeenCalledTimes(1);
      expect(gating.peekPendingPrompt(a)?.payload.id).toBe(qa);
      // The question was pushed aside for it, so it returns on its own.
      qs.setActiveCard(null);
      gating.clearPendingPromptById("pb");
      idx.surfaceNextForDisplay(main);
      await flush();
      expect(renderCalls.at(-1).sessionId).toBe(a);
    });

    it("the main chat's own permission is held back too, and still comes up when the sub's card is done", async () => {
      const main = fresh("main"); const a = fresh("a"); const qa = fresh("qa");
      listen([main, a]);
      gating.setSelectedSessionId(main);
      idx.handleQuestionRequested(subQ(main, a, qa, 1));
      await flush();
      cardUp(qa, a, main);
      idx.handlePermissionRequested({ id: "pm", tool_name: "Bash", input: { command: "ls" }, session_id: main });
      await flush();
      expect(showPermissionCardSpy).not.toHaveBeenCalled();
      qs.setActiveCard(null);
      gating.clearPendingPromptById(qa); // the sub's slot is gone once the daemon resolves it
      idx.surfaceNextForDisplay(main);
      await flush();
      expect(showPermissionCardSpy.mock.calls.map((c) => c[0].id)).toEqual(["pm"]);
    });

    it("still replaces nothing and parks nothing when no question card is up", async () => {
      const main = fresh("main"); const b = fresh("b");
      listen([main, b]);
      gating.setSelectedSessionId(main);
      idx.handlePermissionRequested(perm(main, b, "pb2"));
      await flush();
      expect(showPermissionCardSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("a parked asker the daemon no longer lists", () => {
    it("hands the window to the next parked asker instead of leaving it empty", async () => {
      const main = fresh("main"); const a = fresh("a"); const b = fresh("b"); const qa = fresh("qa"); const qb = fresh("qb");
      listen([main, a, b]);
      gating.setSelectedSessionId("somewhere-else");
      idx.handleQuestionRequested(subQ(main, a, qa, 1));
      idx.handleQuestionRequested(subQ(main, b, qb, 2));
      // a was answered on the phone while Joe was away; the daemon lists only b.
      transportCall.mockResolvedValue([{ id: qb, event: "question-requested", payload: subQ(main, b, qb, 2) }]);
      gating.setSelectedSessionId(main);
      expect(idx.replayPendingPrompt(main)).toBe(true);
      for (let i = 0; i < 6; i++) await flush();
      expect(renderCalls).toHaveLength(1);
      expect(renderCalls[0].sessionId).toBe(b);
    });

    it("walks past several in a row and falls back to the daemon when none is left parked", async () => {
      const main = fresh("main"); const a = fresh("a"); const b = fresh("b"); const c = fresh("c");
      const qa = fresh("qa"); const qb = fresh("qb"); const qc = fresh("qc");
      listen([main, a, b, c]);
      gating.setSelectedSessionId("somewhere-else");
      idx.handleQuestionRequested(subQ(main, a, qa, 1));
      idx.handleQuestionRequested(subQ(main, b, qb, 2));
      idx.handleQuestionRequested(subQ(main, c, qc, 3));
      transportCall.mockResolvedValue([{ id: qc, event: "question-requested", payload: subQ(main, c, qc, 3) }]);
      gating.setSelectedSessionId(main);
      idx.replayPendingPrompt(main);
      for (let i = 0; i < 10; i++) await flush();
      expect(renderCalls.at(-1).sessionId).toBe(c);
      expect(gating.peekPendingPrompt(a)).toBeNull();
      expect(gating.peekPendingPrompt(b)).toBeNull();
    });
  });

  it("a card for another asker arriving while one is on screen parks instead of replacing it", async () => {
    const main = fresh("main"); const a = fresh("a"); const b = fresh("b");
    listen([main, a, b]);
    gating.setSelectedSessionId(main);
    idx.handleQuestionRequested(subQ(main, a, "qa", 2));
    await flush();
    qs.setActiveCard({ id: "qa", sessionId: a, displayId: main, teardown: () => {}, getDraft: () => ({}), expand: () => true });
    const before = renderCalls.length;
    idx.handleQuestionRequested(subQ(main, b, "qb", 1));
    await flush();
    expect(renderCalls.length).toBe(before);
    expect(gating.peekPendingPrompt(b)?.payload.id).toBe("qb");
    expect(sent("confirm_question_rendered").some((c) => c.id === "qb")).toBe(true);
  });
});
