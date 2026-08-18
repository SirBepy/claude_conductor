// @vitest-environment jsdom

// Regression (2026-08-18): the approval-gate fallback card could surface
// "User skipped the question." even after a real submit. Pre-trust keeps our
// own MCP tool off this path; this covers the seatbelt for whatever else
// still reaches it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const renderCalls = [];
const renderQuestionUISpy = vi.fn((opts) => { renderCalls.push(opts); });
import * as qs from "../src/views/sessions/permission-modal/question-state.ts";
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  renderQuestionUI: (opts) => renderQuestionUISpy(opts),
}));

const { showPermissionCard } = await import("../src/views/sessions/permission-modal/permission-card.ts");
const { MCP_ASK_QUESTION_TOOL } = await import("../src/shared/chat/tool-meta.ts");

const QUESTIONS_INPUT = { questions: [{ question: "Tabs or spaces?", options: [{ label: "Tabs" }, { label: "Spaces" }] }] };

function payload(overrides = {}) {
  return { id: "perm-1", tool_name: MCP_ASK_QUESTION_TOOL, input: QUESTIONS_INPUT, session_id: "s1", ...overrides };
}

beforeEach(() => {
  renderCalls.length = 0;
  renderQuestionUISpy.mockClear();
  invokeMock.mockClear();
  qs.setActiveCard(null);
});

describe("permission-gate question fallback: submit never turns a real answer into a skip", () => {
  it("onSubmit resolves via respond_permission (deny+message), never respond_question", async () => {
    showPermissionCard(payload());
    const opts = renderCalls[0];
    await opts.onSubmit({ "Tabs or spaces?": "Spaces" }, { additionalMessage: "", attachments: [] });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("respond_permission");
    expect(args.behavior).toBe("deny");
    expect(args.message).not.toBe("User skipped the question.");
    expect(args.message).toContain("Spaces");
  });

  it("onCancel's message is distinguishable from onSubmit's real-answer message", async () => {
    showPermissionCard(payload());
    const opts = renderCalls[0];
    await opts.onCancel();

    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("respond_permission");
    expect(args.message).not.toBe("User skipped the question.");

    invokeMock.mockClear();
    await opts.onSubmit({ "Tabs or spaces?": "Spaces" }, { additionalMessage: "", attachments: [] });
    const submitMessage = invokeMock.mock.calls[0][1].message;
    expect(submitMessage).not.toBe(args.message);
  });
});

describe("permission-gate question fallback: chip is a fallback-path tell, not shown for our own MCP tool", () => {
  it("no rightChipHtml when the tool IS mcp__cc_conductor__ask_user_question", () => {
    showPermissionCard(payload({ tool_name: MCP_ASK_QUESTION_TOOL }));
    expect(renderCalls[0].rightChipHtml).toBeFalsy();
  });

  it("rightChipHtml IS set for any other tool name", () => {
    showPermissionCard(payload({ tool_name: "some_other_mcp__tool" }));
    expect(renderCalls[0].rightChipHtml).toContain("some_other_mcp__tool");
  });
});

describe("permission-gate question fallback: extras + active-card registration", () => {
  it("supportsExtras is set, and the extra message reaches the submitted deny message", async () => {
    showPermissionCard(payload());
    const opts = renderCalls[0];
    expect(opts.supportsExtras).toBe(true);

    await opts.onSubmit(
      { "Tabs or spaces?": "Spaces" },
      { additionalMessage: "also check the linter config", attachments: [] },
    );
    const message = invokeMock.mock.calls[0][1].message;
    expect(message).toContain("also check the linter config");
  });

  it("threads id/sessionId so the card registers as the active card (draft snapshot/dismiss can find it)", () => {
    showPermissionCard(payload({ id: "perm-9", session_id: "s9" }));
    const opts = renderCalls[0];
    expect(opts.id).toBe("perm-9");
    expect(opts.sessionId).toBe("s9");
  });
});
