// @vitest-environment jsdom

// A guarded `schedule` add stores a shell command the daemon runs on every
// firing, so auto-accept and remembered rules must never answer its card.

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
const SCHEDULE = "mcp__cc_conductor__schedule";
const allowCalls = () => invokeMock.mock.calls.filter(([cmd, a]) => cmd === "respond_permission" && a.behavior === "allow");

beforeEach(() => {
  invokeMock.mockClear();
  clearPendingPrompt(SESSION);
});

describe("needsHumanApproval", () => {
  it("is true only for the schedule tool carrying a non-blank guard", () => {
    expect(needsHumanApproval({ tool_name: SCHEDULE, input: { action: "add", guard: "python check.py" } })).toBe(true);
    expect(needsHumanApproval({ tool_name: SCHEDULE, input: { action: "add", guard: "   " } })).toBe(false);
    expect(needsHumanApproval({ tool_name: SCHEDULE, input: { action: "add", guard: null } })).toBe(false);
    expect(needsHumanApproval({ tool_name: SCHEDULE, input: { action: "add" } })).toBe(false);
    expect(needsHumanApproval({ tool_name: "Bash", input: { guard: "x", command: "ls" } })).toBe(false);
    expect(needsHumanApproval({ tool_name: SCHEDULE })).toBe(false);
  });
});

describe("needsHumanApproval for project_mcp", () => {
  const PROJECT_MCP = "mcp__cc_conductor__project_mcp";

  it("is true for an add (a program started every turn) and false for list and remove", () => {
    expect(needsHumanApproval({ tool_name: PROJECT_MCP, input: { action: "add", name: "Roblox_Studio", command: "cmd.exe" } })).toBe(true);
    expect(needsHumanApproval({ tool_name: PROJECT_MCP, input: { action: "list" } })).toBe(false);
    expect(needsHumanApproval({ tool_name: PROJECT_MCP, input: { action: "remove", name: "x" } })).toBe(false);
    expect(needsHumanApproval({ tool_name: PROJECT_MCP })).toBe(false);
  });

  it("leaves a parked add card for the human when auto-accept turns on", () => {
    storePendingPrompt(SESSION, {
      kind: "permission",
      payload: { id: "p3", tool_name: PROJECT_MCP, input: { action: "add", name: "Roblox_Studio", command: "cmd.exe" }, session_id: SESSION },
    });
    autoAcceptParked(SESSION);
    expect(allowCalls()).toHaveLength(0);
    expect(takePendingPrompt(SESSION)?.payload.id).toBe("p3");
  });
});

describe("turning auto-accept on drains parked permission cards", () => {
  it("allows an ordinary parked card", () => {
    storePendingPrompt(SESSION, { kind: "permission", payload: { id: "p1", tool_name: "Bash", input: { command: "ls" }, session_id: SESSION } });
    autoAcceptParked(SESSION);
    expect(allowCalls()).toHaveLength(1);
  });

  it("leaves a guarded schedule card parked for the human", () => {
    storePendingPrompt(SESSION, {
      kind: "permission",
      payload: { id: "p2", tool_name: SCHEDULE, input: { action: "add", guard: "python check.py" }, session_id: SESSION },
    });
    autoAcceptParked(SESSION);
    expect(allowCalls()).toHaveLength(0);
    expect(takePendingPrompt(SESSION)?.payload.id).toBe("p2");
  });
});
