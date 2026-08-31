// @vitest-environment jsdom

// Clicking "awaiting answer" only consulted the daemon's memory-only prompt
// store, so any card asked before the last daemon restart was unanswerable.
// History carries the tool_use input, which is all a rebuild needs.

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
      // The daemon remembers nothing: the restart this whole fix exists for.
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
// Not re-exported by index.ts, and it must be the same module instance the
// production path parks into - import the gate itself.
const { storePendingPrompt, markLatestQuestion }
  = await import("../src/views/sessions/permission-modal/gating.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");
const { isAuqAnswerBlock } = await import("../src/shared/chat/chat-transforms.ts");

const SESSION = "s1";

/** A transcript card as the renderer holds it: the raw tool_use input, unresolved. */
function transcriptCard(id, questionText) {
  return {
    kind: "question",
    id,
    text: undefined,
    input: { questions: [{ question: questionText, header: id, options: [{ label: "A" }, { label: "B" }] }] },
  };
}

function installRenderer(cards) {
  state.renderer = {
    getOpenQuestion: (id) => cards.find((c) => c.id === id && c.text === undefined) ?? null,
    updateQuestionProgress: () => {},
  };
}

beforeEach(() => {
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

// showQuestionCard chains several awaits before renderQuestionUI runs.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reopening a question the daemon no longer holds", () => {
  it("rebuilds an answerable card from the transcript alone", async () => {
    installRenderer([transcriptCard("q1", "How wide should this run go?")]);

    expect(await reopenPendingPrompt(SESSION, "q1")).toBe(true);
    await flush();

    expect(transportCalls.map((c) => c[0])).toContain("list_pending_prompts");
    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].id).toBe("q1");
    expect(renderCalls[0].questions[0].question).toBe("How wide should this run go?");
    // Options survive the rebuild - a card with no choices is not answerable.
    expect(renderCalls[0].questions[0].options.map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("says no only when the clicked card carries no questions to rebuild from", async () => {
    installRenderer([]);
    expect(await reopenPendingPrompt(SESSION, "q-unknown")).toBe(false);
    expect(renderCalls.length).toBe(0);
  });

  it("reopens the card that was CLICKED, leaving a park for another one alone", async () => {
    installRenderer([transcriptCard("q1", "Older question?"), transcriptCard("q2", "Newer question?")]);
    // The daemon still holds the newer card; the user clicked the older one.
    const parked = { id: "q2", session_id: SESSION, questions: [{ question: "Newer question?" }] };
    storePendingPrompt(SESSION, { kind: "question", payload: parked });

    expect(await reopenPendingPrompt(SESSION, "q1")).toBe(true);
    await flush();

    expect(renderCalls[0].id).toBe("q1");
    // q2's park is still there for its own click.
    expect(await reopenPendingPrompt(SESSION, "q2")).toBe(true);
    await flush();
    expect(renderCalls[1].id).toBe("q2");
  });

  it("answers a superseded card instead of silently dropping it, and names it in the sentinel", async () => {
    installRenderer([transcriptCard("q1", "Older question?")]);
    // A newer question came after q1 - the isLatestQuestion guard that an
    // explicit reopen must bypass.
    markLatestQuestion(SESSION, "q2", 2);

    await reopenPendingPrompt(SESSION, "q1");
    await flush();
    await renderCalls[0].onSubmit({ "Older question?": "A" }, { additionalMessage: "", attachments: [] });
    await flush();

    expect(state.sendCalls.length).toBe(1);
    const block = state.sendCalls[0].find(isAuqAnswerBlock);
    expect(block).toBeDefined();
    expect(block.text).toContain('<auq-answer id="q1"/>');
    expect(block.text).toContain("A");
  });
});
