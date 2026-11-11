// @vitest-environment jsdom
// asserts: src/views/sessions/permission-modal/question-submit.ts

// Delivery contract of a card answer (renderQuestionUI is stubbed here): the
// composer draft in the box when the answer is delivered rides along with it, and
// Skip settles the card. The card's own close-on-Submit is covered by the
// view-harness auq-* specs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd) => {
    if (cmd === "get_session_drafts") {
      return Promise.resolve({ composer: null, auq: null, held: [], held_updated_at: null });
    }
    if (cmd === "respond_question") return Promise.resolve(false);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({ call: vi.fn().mockResolvedValue([]), listen: vi.fn() }),
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
const questions = [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }];
const text = (t) => [{ type: "text", text: t }];

let draft;
let held;
let main;

async function mountCard() {
  main = fresh("main");
  state.sessions = [{ session_id: main }];
  state.selectedId = main;
  gating.setSelectedSessionId(main);
  state.heldMessages = held;
  idx.handleQuestionRequested({ id: fresh("card"), session_id: main, seq: ++n, questions });
  await vi.advanceTimersByTimeAsync(0);
  return renderCalls.at(-1);
}

beforeEach(() => {
  vi.useFakeTimers();
  renderCalls.length = 0;
  invokeMock.mockClear();
  draft = [];
  held = {
    stage: vi.fn(),
    stageFor: vi.fn(() => true),
    flushHeldWithDraft: vi.fn(async () => true),
    getAttached: vi.fn(() => ({
      isDraftEmpty: () => draft.length === 0,
      getDraftBlocks: () => draft,
      clearComposer: vi.fn(() => { draft = []; }),
    })),
  };
  qs.setActiveCard(null);
  gating.setSelectedSessionId(null);
});

describe("a card answer", () => {
  it("is delivered at once on Submit, carrying the draft that was in the box", async () => {
    draft = text("typed before the click");
    const opts = await mountCard();
    // No timer is advanced after Submit: a hold window would leave this unsent.
    await opts.onSubmit({ "Which?": "A" }, { additionalMessage: "", attachments: [] });

    expect(held.stage).toHaveBeenCalledWith(text("typed before the click"));
    expect(held.flushHeldWithDraft).toHaveBeenCalledTimes(1);
    expect(draft).toEqual([]);
    vi.useRealTimers();
  });

  it("is delivered at once with an empty box, and Skip settles the card at once", async () => {
    const opts = await mountCard();
    await opts.onSubmit({ "Which?": "B" }, { additionalMessage: "", attachments: [] });
    expect(held.stage).not.toHaveBeenCalled();
    expect(held.flushHeldWithDraft).toHaveBeenCalledTimes(1);

    invokeMock.mockClear();
    const next = await mountCard();
    await next.onCancel();
    expect(invokeMock).toHaveBeenCalledWith("respond_question", expect.objectContaining({ skipped: true }));
    vi.useRealTimers();
  });
});
