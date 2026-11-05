// @vitest-environment jsdom
// asserts: src/views/sessions/permission-modal/question-submit.ts, src/views/sessions/permission-modal/question-ui-answer-bar.ts

// A card the daemon raised for its own code (a stalled sub, a close approval)
// shows in a main chat that never asked it: its `session_id` IS that chat. Its
// answer belongs to daemon code alone, so no submit or skip path may post a
// message to that chat, flush its composer draft, or stage into its held queue.
// The real card (no free-text box) is driven by e2e/view-harness/subchat-cards.view.spec.ts.

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
vi.mock("../src/views/sessions/permission-modal/permission-card.ts", () => ({
  showPermissionCard: () => {},
  showQuestionReplay: () => {},
}));

const idx = await import("../src/views/sessions/permission-modal/index.ts");
const gating = await import("../src/views/sessions/permission-modal/gating.ts");
const { state } = await import("../src/views/sessions/state.ts");

let n = 0;
const fresh = (p) => `${p}-${++n}`;
const flush = () => new Promise((r) => setTimeout(r, 0));
const sent = (cmd) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
const questions = [{ question: "This sub stopped. What now?", options: [{ label: "Open it" }, { label: "End it" }] }];

const held = { stage: vi.fn(), stageFor: vi.fn(() => true), flushHeldWithDraft: vi.fn(async () => {}), getAttached: vi.fn() };

async function mountCard(extra = {}) {
  const main = fresh("main");
  state.sessions = [{ session_id: main }];
  gating.setSelectedSessionId(main);
  // The main chat's own composer holds an unrelated, unsent draft.
  held.getAttached.mockReturnValue({ isDraftEmpty: () => false, getDraftBlocks: () => [{ type: "text", text: "my unsent draft" }], clearComposer: vi.fn() });
  state.heldMessages = held;
  const id = fresh("card");
  idx.handleQuestionRequested({
    id, session_id: main, display_session_id: main, seq: ++n, sub_id: "sub-1", daemon_card: true, card_kind: "subchat_stuck", questions, ...extra,
  });
  await flush();
  return { main, id, opts: renderCalls.at(-1) };
}

beforeEach(() => {
  renderCalls.length = 0;
  invokeMock.mockClear();
  for (const f of Object.values(held)) if (typeof f.mockClear === "function") f.mockClear();
  transportCall.mockReset().mockResolvedValue([]);
  qs.setActiveCard(null);
  gating.setSelectedSessionId(null);
  state.sessions = [];
});

describe("a daemon card", () => {
  it("is built with no free-text box and no extras", async () => {
    const { opts } = await mountCard();
    expect(opts.daemonCard).toBe(true);
    expect(opts.supportsExtras).toBe(false);
  });

  it("a question a model asked still gets the extras box", async () => {
    const main = fresh("main");
    state.sessions = [{ session_id: main }];
    gating.setSelectedSessionId(main);
    idx.handleQuestionRequested({ id: fresh("m"), session_id: main, seq: ++n, questions });
    await flush();
    expect(renderCalls.at(-1).supportsExtras).toBe(true);
    expect(renderCalls.at(-1).daemonCard).toBe(false);
  });

  it("answering it settles the card and posts nothing to the main chat", async () => {
    const { id, opts } = await mountCard();
    invokeMock.mockImplementation(async (cmd) => (cmd === "respond_question" ? true : undefined));
    await opts.onSubmit({ "This sub stopped. What now?": "End it" }, { additionalMessage: "also do X", attachments: [] });
    expect(sent("respond_question")[0]).toMatchObject({ id, skipped: false });
    expect(sent("send_message")).toHaveLength(0);
    expect(held.stage).not.toHaveBeenCalled();
    expect(held.stageFor).not.toHaveBeenCalled();
    expect(held.flushHeldWithDraft).not.toHaveBeenCalled();
  });

  it("a card withdrawn before the click (not delivered) still posts nothing", async () => {
    const { opts } = await mountCard();
    invokeMock.mockImplementation(async (cmd) => (cmd === "respond_question" ? false : undefined));
    await opts.onSubmit({ "This sub stopped. What now?": "Open it" }, { additionalMessage: "", attachments: [] });
    expect(sent("send_message")).toHaveLength(0);
    expect(held.flushHeldWithDraft).not.toHaveBeenCalled();
    expect(held.stage).not.toHaveBeenCalled();
  });

  it("a failed settle call still posts nothing", async () => {
    const { opts } = await mountCard();
    invokeMock.mockImplementation(async (cmd) => { if (cmd === "respond_question") throw new Error("pipe down"); });
    await opts.onSubmit({ "This sub stopped. What now?": "Open it" }, { additionalMessage: "x", attachments: [] });
    expect(sent("send_message")).toHaveLength(0);
    expect(held.flushHeldWithDraft).not.toHaveBeenCalled();
  });

  it("Skip settles it as a skip and posts nothing", async () => {
    const { id, opts } = await mountCard();
    await opts.onCancel();
    expect(sent("respond_question")[0]).toMatchObject({ id, skipped: true });
    expect(sent("send_message")).toHaveLength(0);
    expect(held.stage).not.toHaveBeenCalled();
  });
});

describe("a model's own card keeps delivering to its chat", () => {
  it("an undelivered answer is sent to the chat that asked", async () => {
    const main = fresh("main");
    state.sessions = [{ session_id: main }];
    gating.setSelectedSessionId(main);
    held.getAttached.mockReturnValue(null);
    state.heldMessages = null;
    const id = fresh("m");
    idx.handleQuestionRequested({ id, session_id: main, seq: ++n, questions });
    await flush();
    invokeMock.mockImplementation(async (cmd) => (cmd === "respond_question" ? false : undefined));
    await renderCalls.at(-1).onSubmit({ "This sub stopped. What now?": "Open it" }, { additionalMessage: "", attachments: [] });
    expect(sent("send_message").map((s) => s.sessionId)).toEqual([main]);
  });
});
