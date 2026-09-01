// @vitest-environment jsdom

// todo 755: clicking an ANSWERED question card in the transcript used to hit
// an early return - no read-only replay, no toast, nothing. Covers the new
// replay path, plus a regression check on the already-shipped PENDING path
// (ab98eca4): clicking the same still-open card twice must not double-open it.

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

const { transportCalls } = vi.hoisted(() => ({ transportCalls: [] }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({
    call: (method, args) => {
      transportCalls.push([method, args]);
      if (method === "list_pending_prompts") return Promise.resolve([]);
      return Promise.resolve(undefined);
    },
  }),
}));

const { renderCalls, renderQuestionUISpy } = vi.hoisted(() => {
  const renderCalls = [];
  return { renderCalls, renderQuestionUISpy: vi.fn((opts) => { renderCalls.push(opts); }) };
});
import * as qs from "../src/views/sessions/permission-modal/question-state.ts";
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
  snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
  isQuestionAnswered: (...a) => qs.isQuestionAnswered(...a),
  renderQuestionUI: (opts) => renderQuestionUISpy(opts),
}));

const { reopenPendingPrompt, setSelectedSessionId }
  = await import("../src/views/sessions/permission-modal/index.ts");
const { reopenAnsweredPrompt } = await import("../src/views/sessions/permission-modal/resurface.ts");
const { HOST_ID } = await import("../src/views/sessions/permission-modal/host.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");

const SESSION = "s1";

/** A still-open transcript card, as the renderer holds it: raw tool_use
 *  input, unresolved (no `text`). */
function pendingCard(id, questionText) {
  return {
    kind: "question",
    id,
    text: undefined,
    input: { questions: [{ question: questionText, header: id, options: [{ label: "A" }, { label: "B" }] }] },
  };
}

/** A resolved transcript card, as the renderer holds it once the tool_result
 *  folded the answer back in (see chat-question-card.ts's resolvePendingQuestionCard). */
function answeredCard(id, questionText, answerLabel) {
  return {
    kind: "question",
    id,
    text: `User answered the question(s):\nQ: ${questionText}\nA: ${answerLabel}`,
    input: { questions: [{ question: questionText, options: [{ label: answerLabel }] }] },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  renderCalls.length = 0;
  transportCalls.length = 0;
  renderQuestionUISpy.mockClear();
  invokeMock.mockClear();
  qs.setActiveCard(null);
  localStorage.clear();

  state.sessions = [{ session_id: SESSION }];
  state.selectedId = SESSION;
  state.pendingNewSession = null;
  setSelectedSessionId(SESSION);
  state.renderer = { messages: [] };

  const sendCalls = [];
  state.heldMessages = new HeldMessages();
  state.heldMessages.attach({
    sessionId: SESSION,
    chipSlot: document.createElement("div"),
    anchor: document.createElement("div"),
    send: (blocks) => { sendCalls.push(blocks); },
    interrupt: () => {},
    getDraftBlocks: () => [],
    isDraftEmpty: () => true,
    isComposing: () => false,
    clearComposer: () => {},
    getIsBusy: () => false,
    onChange: () => {},
  });
  state.sendCalls = sendCalls;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("clicking an ANSWERED question card", () => {
  it("reopens it as a read-only replay showing the question and the picked answer", () => {
    state.renderer.messages = [answeredCard("q1", "Which theme?", "Dark")];

    expect(reopenAnsweredPrompt("q1")).toBe(true);

    const host = document.getElementById(HOST_ID);
    expect(host).toBeTruthy();
    expect(host.textContent).toContain("Which theme?");
    expect(host.textContent).toContain("Dark");
    // Read-only: no submit control, only a dismiss.
    expect(host.querySelector('[data-act="primary"]')).toBeNull();
    expect(host.querySelector('[data-act="close"]')).toBeTruthy();
  });

  it("is dismissable by its Close button, same as any other card", () => {
    state.renderer.messages = [answeredCard("q1", "Which theme?", "Dark")];
    reopenAnsweredPrompt("q1");

    document.getElementById(HOST_ID).querySelector('[data-act="close"]').click();

    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it("is dismissable via Escape, same as the live permission card", () => {
    state.renderer.messages = [answeredCard("q1", "Which theme?", "Dark")];
    reopenAnsweredPrompt("q1");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it("says no when the card isn't in the loaded transcript, so the caller can toast", () => {
    state.renderer.messages = [];
    expect(reopenAnsweredPrompt("q-unknown")).toBe(false);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });
});

describe("clicking the same still-pending question card twice (ab98eca4 regression)", () => {
  it("re-shows the one card clicked both times, never a stale or duplicate one", async () => {
    state.renderer = {
      getOpenQuestion: (id) => (id === "q1" ? pendingCard("q1", "Pick a color?") : null),
      updateQuestionProgress: () => {},
    };

    expect(await reopenPendingPrompt(SESSION, "q1")).toBe(true);
    await flush();
    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].id).toBe("q1");

    // A second click on the SAME card, after the first fully settled - the
    // whole point of ab98eca4 (the click-to-reopen widening) is that this
    // still targets q1 again, not a second competing card.
    expect(await reopenPendingPrompt(SESSION, "q1")).toBe(true);
    await flush();
    expect(renderCalls.length).toBe(2);
    expect(renderCalls[1].id).toBe("q1");
  });
});
