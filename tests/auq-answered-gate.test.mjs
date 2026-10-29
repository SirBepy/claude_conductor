// @vitest-environment jsdom

// A question already answered (in the transcript, or by a previous settle in
// this window) must never be shown or re-parked, and a parked question is only
// re-shown while the daemon still lists it. Joe's report: after an app update a
// question answered inline in the transcript popped again as pending, and again
// on every switch-back.

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

const { daemon } = vi.hoisted(() => ({ daemon: { prompts: [], fail: false } }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({
    call: (method) => {
      if (method === "list_pending_prompts") {
        return daemon.fail ? Promise.reject(new Error("offline")) : Promise.resolve(daemon.prompts);
      }
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
  confirmQuestionRendered: () => {},
  renderQuestionUI: (opts) => renderQuestionUISpy(opts),
}));

const { handleQuestionRequested, setSelectedSessionId, reopenPendingPrompt } =
  await import("../src/views/sessions/permission-modal/index.ts");
const { replayPendingPrompt, rehydrateAndReplay } = await import("../src/views/sessions/permission-modal/resurface.ts");
const { markPendingPromptAnswered, storePendingPrompt, clearPendingPrompt } =
  await import("../src/views/sessions/permission-modal/gating.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
const { auqAnswerSentinel } = await import("../src/shared/chat/chat-transforms.ts");

const SESSION = "s1";
let seq = 0;
const freshId = () => `prompt-${++seq}`;

function payload(id) {
  return { id, session_id: SESSION, questions: [{ question: "Build it?", options: [{ label: "Yes" }, { label: "No" }] }] };
}

function daemonLists(...ids) {
  daemon.prompts = ids.map((id) => ({ id, event: "question-requested", durable: true, payload: payload(id) }));
}

/** The answer message as the transcript holds it after a fire-and-forget answer. */
function answerInTranscript(id) {
  sessionEvents.pushSynthetic(SESSION, {
    type: "user_message",
    content: [{ type: "text", text: `${auqAnswerSentinel(id)}User answered the question(s):\nQ: Build it?\nA: Yes` }],
    timestamp: 0,
    remote_echo: false,
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const skipCalls = () => invokeMock.mock.calls.filter((c) => c[0] === "respond_question" && c[1].skipped === true);

beforeEach(() => {
  document.body.innerHTML = "";
  renderCalls.length = 0;
  renderQuestionUISpy.mockClear();
  invokeMock.mockClear();
  qs.setActiveCard(null);
  clearPendingPrompt(SESSION);
  sessionEvents.bust(SESSION);
  localStorage.clear();
  daemon.prompts = [];
  daemon.fail = false;

  state.sessions = [{ session_id: SESSION }];
  state.selectedId = SESSION;
  state.pendingNewSession = null;
  state.renderer = { messages: [] };
  setSelectedSessionId(SESSION);
});

describe("a question answered in the transcript", () => {
  it("is not shown when the daemon announces it, and the daemon is told to stop serving it", async () => {
    const id = freshId();
    answerInTranscript(id);

    handleQuestionRequested(payload(id));
    await flush();

    expect(renderQuestionUISpy).not.toHaveBeenCalled();
    expect(skipCalls()).toHaveLength(1);
    expect(skipCalls()[0][1]).toMatchObject({ id, sessionId: SESSION, skipped: true });
  });

  it("is not shown by a reload that finds it still pending on the daemon", async () => {
    const id = freshId();
    answerInTranscript(id);
    daemonLists(id);

    await rehydrateAndReplay(SESSION);
    await flush();

    expect(renderQuestionUISpy).not.toHaveBeenCalled();
    expect(skipCalls()).toHaveLength(1);
  });

  it("does not hide a different, genuinely open question in the same chat", async () => {
    const answered = freshId();
    const open = freshId();
    answerInTranscript(answered);

    handleQuestionRequested(payload(open));
    await flush();

    expect(renderQuestionUISpy).toHaveBeenCalledTimes(1);
    expect(renderCalls[0].id).toBe(open);
    expect(skipCalls()).toHaveLength(0);
  });
});

describe("a parked question on switch-back", () => {
  it("is not re-shown once it was answered, even though the daemon still lists it", async () => {
    const id = freshId();
    storePendingPrompt(SESSION, { kind: "question", payload: payload(id) });
    markPendingPromptAnswered(SESSION, id);
    daemonLists(id);

    expect(replayPendingPrompt(SESSION)).toBe(true);
    await flush();

    expect(renderQuestionUISpy).not.toHaveBeenCalled();
  });

  it("is not re-shown when the daemon no longer lists it", async () => {
    const id = freshId();
    storePendingPrompt(SESSION, { kind: "question", payload: payload(id) });
    daemon.prompts = [];

    replayPendingPrompt(SESSION);
    await flush();

    expect(renderQuestionUISpy).not.toHaveBeenCalled();
  });

  it("is re-shown while the daemon still lists it", async () => {
    const id = freshId();
    storePendingPrompt(SESSION, { kind: "question", payload: payload(id) });
    daemonLists(id);

    replayPendingPrompt(SESSION);
    await flush();

    expect(renderQuestionUISpy).toHaveBeenCalledTimes(1);
    expect(renderCalls[0].id).toBe(id);
  });

  it("is still re-shown when the daemon cannot be reached", async () => {
    const id = freshId();
    storePendingPrompt(SESSION, { kind: "question", payload: payload(id) });
    daemon.fail = true;

    replayPendingPrompt(SESSION);
    await flush();

    expect(renderQuestionUISpy).toHaveBeenCalledTimes(1);
  });

  it("makes way for a different prompt the daemon does hold for the chat", async () => {
    const gone = freshId();
    const live = freshId();
    storePendingPrompt(SESSION, { kind: "question", payload: payload(gone) });
    daemonLists(live);

    replayPendingPrompt(SESSION);
    await flush();
    await flush();

    expect(renderQuestionUISpy).toHaveBeenCalledTimes(1);
    expect(renderCalls[0].id).toBe(live);
  });
});

describe("a collapsed card", () => {
  function activeCard(id, expand) {
    qs.setActiveCard({ id, sessionId: SESSION, teardown: () => {}, getDraft: () => ({}), expand });
  }

  it("re-expands when the daemon announces the same prompt again, without a second mount", async () => {
    const id = freshId();
    const expand = vi.fn(() => true);
    activeCard(id, expand);

    handleQuestionRequested(payload(id));
    await flush();

    expect(expand).toHaveBeenCalledTimes(1);
    expect(renderQuestionUISpy).not.toHaveBeenCalled();
  });

  it("re-expands when its transcript card is clicked", async () => {
    const id = freshId();
    const expand = vi.fn(() => true);
    activeCard(id, expand);
    storePendingPrompt(SESSION, { kind: "question", payload: payload(id) });
    daemonLists(id);

    await reopenPendingPrompt(SESSION, "toolu_transcript_id");

    expect(expand).toHaveBeenCalledTimes(1);
    expect(renderQuestionUISpy).not.toHaveBeenCalled();
  });
});
