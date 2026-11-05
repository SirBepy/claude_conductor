// asserts: src/shared/chat/builtins/clear.ts
// `/clear` ends the chat it is typed in and starts a new one in the same project.
// In a sub's view that would end a job the main chat handed out (its brief is the
// job) and start an unrelated chat, so it is refused with a toast. On a main chat
// with a sub still running the daemon holds the close and asks Joe on a card, and
// `/clear` must not start a new chat under that card. The real keys and the phone
// width are driven by e2e/view-harness/subchat-leave.view.spec.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, toastMock, launchMock, stateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
  toastMock: vi.fn(),
  launchMock: vi.fn(async () => undefined),
  stateMock: { sessions: [] },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: toastMock }));
vi.mock("../src/views/sessions/state.ts", () => ({ state: stateMock }));
vi.mock("../src/views/sessions/pending-flow.ts", () => ({ launchNewSession: launchMock }));
vi.mock("../src/views/sessions/new-chat-config.ts", () => ({ resolveNewChatConfig: async () => ({ model: "m" }) }));

const { clearSession, SUB_CLEAR_REFUSAL } = await import("../src/shared/chat/builtins/clear.ts");

const ctx = (sessionId) => ({ sessionId, projectDir: "C:/Projects/cv-site", getRenderer: () => null, pane: {} });
const parsed = { name: "clear", args: "" };

describe("/clear", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => undefined);
    toastMock.mockClear();
    launchMock.mockClear();
    stateMock.sessions = [
      { session_id: "main", subchat_of: null },
      { session_id: "sub", subchat_of: "main" },
      { session_id: "plain", subchat_of: null },
    ];
  });

  it("is refused in a sub's view: a toast says why, nothing is closed and no chat starts", async () => {
    await clearSession(parsed, ctx("sub"));
    expect(toastMock).toHaveBeenCalledWith(SUB_CLEAR_REFUSAL);
    expect(SUB_CLEAR_REFUSAL).toContain("brief");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("starts no new chat when the daemon held the close of a main chat with a running sub", async () => {
    invokeMock.mockImplementation(async (cmd) => (cmd === "clear_session" ? true : undefined));
    await clearSession(parsed, ctx("main"));
    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "main" });
    expect(launchMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("still closes the chat and starts a fresh one when nothing is holding it", async () => {
    await clearSession(parsed, ctx("plain"));
    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "plain" });
    expect(launchMock).toHaveBeenCalledTimes(1);
    // A main chat whose subs have all finished is closed by the daemon without a card.
    launchMock.mockClear();
    invokeMock.mockImplementation(async () => false);
    await clearSession(parsed, ctx("main"));
    expect(launchMock).toHaveBeenCalledTimes(1);
  });
});
