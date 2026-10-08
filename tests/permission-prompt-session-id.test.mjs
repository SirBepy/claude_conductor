// Multi-machine federation (docs/multi-machine.md, task "prompt answers carry
// session_id"): the daemon forwards a prompt answer to the peer machine that
// owns the turn by looking at its session id, not its (globally-scoped)
// responder id alone - so every respond_permission/confirm_question_rendered
// call must carry sessionId. Covers the two helpers not already exercised via
// a full showPermissionCard/handleQuestionRequested round trip elsewhere
// (permission-gate-question-fallback.test.mjs, auq-answer-envelope-and-draft
// .test.mjs cover those call sites).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { allowPermission } = await import("../src/views/sessions/permission-modal/gating.ts");
const { confirmQuestionRendered } = await import("../src/views/sessions/permission-modal/question-ui.ts");

beforeEach(() => {
  invokeMock.mockClear();
});

describe("allowPermission", () => {
  it("passes the payload's session_id through as sessionId", () => {
    allowPermission({ id: "perm-1", tool_name: "Bash", input: {}, session_id: "s-mirror" }, "test");
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("respond_permission");
    expect(args.sessionId).toBe("s-mirror");
  });

  it("still calls through with sessionId undefined when the payload has none", () => {
    allowPermission({ id: "perm-2", tool_name: "Bash", input: {} }, "test");
    const [, args] = invokeMock.mock.calls[0];
    expect(args.sessionId).toBeUndefined();
  });
});

describe("confirmQuestionRendered", () => {
  it("passes sessionId through to confirm_question_rendered", () => {
    confirmQuestionRendered("q-1", "s-mirror");
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("confirm_question_rendered");
    expect(args.id).toBe("q-1");
    expect(args.sessionId).toBe("s-mirror");
  });

  it("no-ops without ever calling invoke when id is undefined", () => {
    confirmQuestionRendered(undefined, "s-mirror");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
