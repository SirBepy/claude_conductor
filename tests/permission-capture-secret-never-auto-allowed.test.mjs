// @vitest-environment jsdom
// asserts: src/views/sessions/permission-modal/gating.ts

// `capture_secret_from_page` copies a credential off a page into a file. A page the chat
// read could otherwise talk the model into a save, so auto-accept and remembered rules
// must never answer its card: only a person's own click does.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

import * as qs from "../src/views/sessions/permission-modal/question-state.ts";
vi.mock("../src/views/sessions/permission-modal/question-ui.ts", () => ({
  extractQuestions: (...a) => qs.extractQuestions(...a),
  formatAnswersAsMessage: (...a) => qs.formatAnswersAsMessage(...a),
  dismissQuestionCard: (...a) => qs.dismissQuestionCard(...a),
  snapshotActiveCardDraft: (...a) => qs.snapshotActiveCardDraft(...a),
  renderQuestionUI: vi.fn(),
}));

const { needsHumanApproval, storePendingPrompt, takePendingPrompt, clearPendingPrompt } = await import(
  "../src/views/sessions/permission-modal/gating.ts"
);
const { autoAcceptParked } = await import("../src/views/sessions/permission-modal/resurface.ts");

const SESSION = "s1";
const CAPTURE = "mcp__cc_conductor__capture_secret_from_page";
const allowCalls = () => invokeMock.mock.calls.filter(([cmd, a]) => cmd === "respond_permission" && a.behavior === "allow");

beforeEach(() => {
  invokeMock.mockClear();
  clearPendingPrompt(SESSION);
});

describe("needsHumanApproval for capture_secret_from_page", () => {
  it("is always true, and an unrelated tool is not caught by it", () => {
    expect(needsHumanApproval({ tool_name: CAPTURE, input: { label: "OVH client secret", file: ".env.ovh", key: "OVH_SECRET", element: "#secret" } })).toBe(true);
    expect(needsHumanApproval({ tool_name: CAPTURE })).toBe(true);
    expect(needsHumanApproval({ tool_name: "mcp__cc_conductor__request_secret" })).toBe(false);
  });

  it("leaves a parked capture card for the human when auto-accept turns on", () => {
    storePendingPrompt(SESSION, {
      kind: "permission",
      payload: { id: "p4", tool_name: CAPTURE, input: { label: "OVH client secret", file: ".env.ovh", key: "OVH_SECRET", element: "#secret" }, session_id: SESSION },
    });
    autoAcceptParked(SESSION);
    expect(allowCalls()).toHaveLength(0);
    expect(takePendingPrompt(SESSION)?.payload.id).toBe("p4");
  });
});
