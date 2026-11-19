// @vitest-environment jsdom

// pc-1786: a secret request is one pending card among the others. It used to take
// the window's only slot, so a sub's question could neither show nor be answered
// until Joe gave the key or cancelled. This pins the queue model: who owns the
// slot, the picker's chips and their order (a secret never ahead of a question),
// what the next card is, and that nothing answers the secret on Joe's behalf. The
// drawn card is covered by e2e/view-harness/secret-card-with-other-cards.view.spec.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, transportCall } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd) => {
    if (cmd === "get_session_drafts") {
      return Promise.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    }
    return Promise.resolve(true);
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
  // Like the real card: it replaces whatever card host holds and registers itself as the one on screen.
  renderQuestionUI: (opts) => {
    renderCalls.push(opts);
    secretCard.dismissSecretCard();
    qs.setActiveCard({
      id: opts.id, sessionId: opts.sessionId, displayId: opts.displayId,
      teardown: () => qs.setActiveCard(null), getDraft: () => ({}), expand: () => false,
    });
  },
}));
vi.mock("../src/views/sessions/permission-modal/permission-card.ts", () => ({
  showPermissionCard: () => {},
  showQuestionReplay: () => {},
}));

const idx = await import("../src/views/sessions/permission-modal/index.ts");
const gating = await import("../src/views/sessions/permission-modal/gating.ts");
const askers = await import("../src/views/sessions/permission-modal/askers.ts");
const submit = await import("../src/views/sessions/permission-modal/question-submit.ts");
const secretCard = await import("../src/views/sessions/permission-modal/secret-card.ts");
const { state } = await import("../src/views/sessions/state.ts");

let n = 0;
const fresh = (p) => `${p}-${++n}`;
const qn = (count) => Array.from({ length: count }, (_, i) => ({ question: `Q${i + 1}?`, options: [{ label: "A" }, { label: "B" }] }));
const subQ = (main, sub, id, count = 1, extra = {}) => ({
  id, session_id: sub, display_session_id: main, sub_name: `name-${sub}`, seq: ++n, questions: qn(count), ...extra,
});
const secretReq = (session, id = fresh("sec")) => ({ id, session_id: session, label: "k", file: "C:\\r\\.env", key: "API_KEY" });
const flush = () => new Promise((r) => setTimeout(r, 0));
const sent = (cmd) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
const host = () => document.getElementById("prompt-card-host");
const secretUp = () => !!host()?.querySelector(".secret-card__input");

function listen(ids) {
  state.sessions = ids.map((id) => ({ session_id: id, name: `name-${id}` }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  renderCalls.length = 0;
  invokeMock.mockClear();
  transportCall.mockReset().mockResolvedValue([]);
  secretCard.dismissSecretCard();
  qs.setActiveCard(null);
  for (const id of gating.pendingPromptSessionIds()) gating.clearPendingPrompt(id);
  gating.setSelectedSessionId(null);
  state.sessions = [];
  window.__TAURI__ = {};
});

describe("secret first, then another chat's question", () => {
  it("keeps the secret card on screen, holds the question behind it and offers both in the picker", async () => {
    const main = fresh("main"); const sub = fresh("sub"); const qid = fresh("q");
    listen([main, sub]);
    gating.setSelectedSessionId(main);
    const sec = secretReq(main);
    idx.handleSecretRequested(sec);
    expect(secretUp()).toBe(true);

    idx.handleQuestionRequested(subQ(main, sub, qid));

    await flush();

    // The question never tore the secret card down, and nothing was answered.
    expect(secretUp()).toBe(true);
    expect(renderCalls).toHaveLength(0);
    expect(sent("respond_secret")).toHaveLength(0);
    expect(gating.peekPendingPrompt(sub)?.payload.id).toBe(qid);
    // Both are in the picker, the question ahead of the secret, the secret marked.
    const chips = askers.askerChips(main, main);
    expect(chips.map((c) => c.askerId)).toEqual([sub, main]);
    expect(chips.map((c) => !!c.secret)).toEqual([false, true]);
    expect(chips.find((c) => c.secret).active).toBe(true);
    // A secret is never a "blocking" prompt: it waits behind a question, not ahead of it.
    expect(chips.every((c) => !c.blocking)).toBe(true);
  });

  it("answering the question first brings the secret card back, still unanswered", async () => {
    const main = fresh("main"); const sub = fresh("sub"); const qid = fresh("q");
    listen([main, sub]);
    gating.setSelectedSessionId(main);
    idx.handleSecretRequested(secretReq(main));
    idx.handleQuestionRequested(subQ(main, sub, qid));
    await flush();

    submit.pickAsker(main, sub);
    await flush();
    // The question took the window; the secret request is parked, not cancelled.
    expect(secretUp()).toBe(false);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].sessionId).toBe(sub);
    expect(gating.peekPendingPrompt(main)?.kind).toBe("secret");
    expect(askers.openAskersFor(main).map((a) => a.askerId).sort()).toEqual([main, sub].sort());
    expect(sent("respond_secret")).toHaveLength(0);
  });
});

describe("question first, then a secret request", () => {
  it("leaves the open question alone and shows the secret as a chip, never as the next card ahead of a question", async () => {
    const main = fresh("main"); const sub = fresh("sub"); const qid = fresh("q");
    listen([main, sub]);
    gating.setSelectedSessionId(main);
    idx.handleQuestionRequested(subQ(main, sub, qid));
    await flush();
    expect(renderCalls).toHaveLength(1);

    idx.handleSecretRequested(secretReq(main));

    expect(secretUp()).toBe(false);
    expect(renderCalls).toHaveLength(1);
    const chips = askers.askerChips(main, sub);
    expect(chips.map((c) => c.askerId)).toEqual([sub, main]);
    expect(chips.find((c) => c.askerId === sub).active).toBe(true);
    // The window's next card is the question, not the key request.
    expect(askers.nextParkedAskerFor(main)).toBe(sub);
  });

  it("the secret takes the window once the question is gone, and not before", async () => {
    const main = fresh("main"); const sub = fresh("sub"); const qid = fresh("q");
    listen([main, sub]);
    gating.setSelectedSessionId(main);
    idx.handleQuestionRequested(subQ(main, sub, qid));
    await flush();
    const sec = secretReq(main);
    idx.handleSecretRequested(sec);
    expect(secretUp()).toBe(false);

    // The question settles (the daemon resolved it): the parked secret is what is left.
    gating.clearPendingPromptById(qid);
    expect(askers.nextParkedAskerFor(main)).toBe(main);
    expect(gating.peekPendingPrompt(main)?.payload.id).toBe(sec.id);
  });
});

describe("one chat asking for both", () => {
  it("a chat's own question waits behind its open secret card and shows when the secret is cancelled", async () => {
    const main = fresh("main");
    listen([main]);
    gating.setSelectedSessionId(main);
    const sec = secretReq(main);
    idx.handleSecretRequested(sec);
    idx.handleQuestionRequested({ id: "own-q", session_id: main, seq: ++n, questions: qn(1) });
    await flush();

    // One slot per chat: queued, not dropped and not shown over the key request.
    expect(secretUp()).toBe(true);
    expect(renderCalls).toHaveLength(0);
    expect(idx.queuedQuestionsFor(main)).toHaveLength(1);

    host().querySelector('[data-act="cancel"]').click();
    await flush();
    expect(sent("respond_secret")).toEqual([{ requestId: sec.id, value: null, cancelled: true }]);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].payload?.id ?? renderCalls[0].requestId ?? "own-q").toBe("own-q");
  });

  it("a second secret request from the same chat queues, and counts in the picker", async () => {
    const main = fresh("main"); const sub = fresh("sub"); const qid = fresh("q");
    listen([main, sub]);
    gating.setSelectedSessionId(main);
    idx.handleSecretRequested(secretReq(main));
    idx.handleSecretRequested(secretReq(main));
    expect(idx.queuedSecretsFor(main)).toHaveLength(1);
    idx.handleQuestionRequested(subQ(main, sub, qid));
    await flush();
    const secretAsker = askers.openAskersFor(main).find((a) => a.askerId === main);
    expect(secretAsker.secret).toBe(true);
    expect(secretAsker.count).toBe(2);
  });
});

describe("a secret never hides another chat's card", () => {
  it("a secret for a chat that is not on screen parks and does not take the open chat's window", async () => {
    const a = fresh("a"); const b = fresh("b");
    listen([a, b]);
    gating.setSelectedSessionId(a);
    idx.handleQuestionRequested({ id: "qa", session_id: a, seq: ++n, questions: qn(1) });
    await flush();
    idx.handleSecretRequested(secretReq(b));
    expect(secretUp()).toBe(false);
    expect(renderCalls).toHaveLength(1);
    expect(gating.pendingPromptSessionIds()).toContain(b);
  });

  it("Cancel on the secret card still cancels, and the other chat's card is untouched", async () => {
    const main = fresh("main"); const sub = fresh("sub"); const qid = fresh("q");
    listen([main, sub]);
    gating.setSelectedSessionId(main);
    const sec = secretReq(main);
    idx.handleSecretRequested(sec);
    const q = subQ(main, sub, qid);
    idx.handleQuestionRequested(q);
    await flush();
    // The daemon still holds the question, so it is what comes up once the secret is gone.
    transportCall.mockResolvedValue([{ id: qid, event: "question-requested", durable: true, payload: q }]);
    host().querySelector('[data-act="cancel"]').click();
    await flush();
    expect(sent("respond_secret")).toEqual([{ requestId: sec.id, value: null, cancelled: true }]);
    // The question comes up on its own once the secret has left.
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].sessionId).toBe(sub);
    expect(sent("respond_question")).toHaveLength(0);
  });
});
