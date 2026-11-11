// @vitest-environment jsdom
// asserts: src/views/sessions/permission-modal/question-submit.ts

// A card answer waits out the Undo grace window with the composer still live. The
// composer draft that rides along with the answer is the box as it was when Submit
// was pressed; a next message typed during the window must not be staged, cleared
// from the box and sent mid-sentence bundled with the answer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
const { flushAllGrace } = await import("../src/shared/chat/send-grace.ts");

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

/** Press Submit: the card is held for the window, the box is whatever `draft` is. */
async function submit(opts) {
  const heldCard = { mount: document.createElement("div"), release: vi.fn(), thaw: vi.fn(() => true) };
  await opts.onSubmit({ "Which?": "A" }, { additionalMessage: "", attachments: [] }, heldCard);
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.__ccSendGraceMs = 3000;
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

afterEach(() => {
  flushAllGrace();
  vi.useRealTimers();
  globalThis.__ccSendGraceMs = 0;
});

describe("a card answer held in its Undo window", () => {
  it("still carries the draft that was in the box when Submit was pressed", async () => {
    draft = text("typed before the click");
    const opts = await mountCard();
    await submit(opts);
    await vi.advanceTimersByTimeAsync(3001);

    expect(held.stage).toHaveBeenCalledWith(text("typed before the click"));
    expect(held.flushHeldWithDraft).toHaveBeenCalledTimes(1);
    expect(draft).toEqual([]);
  });

  it("leaves a next message typed during the window in the box instead of sending it mid-sentence", async () => {
    const opts = await mountCard();
    await submit(opts);
    draft = text("half a sentence I am still typ");
    await vi.advanceTimersByTimeAsync(3001);

    expect(held.stage).not.toHaveBeenCalled();
    expect(held.flushHeldWithDraft).toHaveBeenCalledTimes(1);
    expect(draft).toEqual(text("half a sentence I am still typ"));
  });

  it("does not stage a draft that grew during the window either", async () => {
    draft = text("before");
    const opts = await mountCard();
    await submit(opts);
    draft = text("before and then more");
    await vi.advanceTimersByTimeAsync(3001);

    expect(held.stage).not.toHaveBeenCalled();
    expect(draft).toEqual(text("before and then more"));
  });
});
