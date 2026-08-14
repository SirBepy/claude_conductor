// @vitest-environment jsdom

// The daemon stamps degraded_builtin onto the PROMPT PAYLOAD, never the
// model's tool_use input (tool-views.ts's transcript-side read is stale).
// Proves showQuestionCard threads it into renderQuestionUI's opts - see
// auq-degraded-badge-render.test.mjs for proof it reaches the DOM.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn((cmd) => cmd === "get_session_drafts"
  ? Promise.resolve({ composer: null, auq: null, held: [], held_updated_at: null })
  : Promise.resolve(undefined));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const renderCalls = [];
const renderQuestionUISpy = vi.fn((opts) => { renderCalls.push(opts); });
import * as qs from "../src/views/sessions/permission-modal/question-state.ts";
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  isQuestionAnswered: (...a) => qs.isQuestionAnswered(...a),
  snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
  renderQuestionUI: (opts) => renderQuestionUISpy(opts),
}));

const { showQuestionCard } = await import("../src/views/sessions/permission-modal/index.ts");

beforeEach(() => {
  renderCalls.length = 0;
  renderQuestionUISpy.mockClear();
  invokeMock.mockClear();
  qs.setActiveCard(null);
});

describe("showQuestionCard threads payload.degraded_builtin into the render opts", () => {
  it("degraded_builtin: true on the payload becomes opts.degradedBuiltin", async () => {
    await showQuestionCard({
      id: "p1", session_id: "s1", questions: [{ question: "Pick one?" }], degraded_builtin: true,
    });
    expect(renderCalls[0].degradedBuiltin).toBe(true);
  });

  it("is false when the payload doesn't carry the flag (defensive default)", async () => {
    await showQuestionCard({ id: "p2", session_id: "s1", questions: [{ question: "Pick one?" }] });
    expect(renderCalls[0].degradedBuiltin).toBe(false);
  });
});
