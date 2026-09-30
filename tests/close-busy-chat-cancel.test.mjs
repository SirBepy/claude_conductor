// Closing a busy chat from the sidebar menu asks "discard the turn?" first.
// The row's exit animation used to start on the Close click, before that
// answer, and a click-close exit is sticky: a Cancel then left the still-open
// chat hidden from the sidebar for good (todo 926, found by the billed
// chat-flow run, whose closed chat was still mid-turn).

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, markExitingMock, stateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
  markExitingMock: vi.fn(),
  stateMock: { sessions: [], selectedId: null, activeChatActions: null, renderer: null },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/api.ts", () => ({ api: { playCharacterSlot: vi.fn(async () => undefined) } }));
vi.mock("../src/shared/http-transport.ts", () => ({
  RemoteUnavailableError: class RemoteUnavailableError extends Error {},
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
vi.mock("../src/views/sessions/permission-modal", () => ({
  isAutoAccept: () => false,
  setAutoAccept: () => {},
  autoAcceptParked: () => {},
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadHiddenSessions: () => new Set(),
  saveHiddenSessions: () => {},
  loadHiddenCollapsed: () => false,
  saveHiddenCollapsed: () => {},
  toggleSegCollapse: () => {},
}));
vi.mock("../src/shared/chat/message-filter-pref.ts", () => ({
  isRawViewEnabled: () => false,
  setRawViewEnabled: () => {},
}));
vi.mock("../src/views/sessions/state.ts", () => ({ state: stateMock }));
vi.mock("../src/views/sessions/session-characters.ts", () => ({ characterForSession: () => null }));
vi.mock("../src/views/sessions/active-session-account.ts", () => ({
  changeCharacterForSession: vi.fn(),
  changeAccountForSession: vi.fn(),
}));
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({ sendWithFailureRecovery: vi.fn() }));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: { pushSynthetic: vi.fn(), removeSynthetic: vi.fn() },
}));
vi.mock("../src/views/sessions/sidebar-anim.ts", () => ({
  loadAnimEnabled: () => true,
  markSessionExiting: markExitingMock,
}));

const { openCtxMenu } = await import("../src/views/sessions/sidebar-ctx-menu.ts");

function mountRow(id) {
  document.body.innerHTML = `<ul id="sessions-list"><li data-session-id="${id}"><span>${id}</span></li></ul>`;
  return document.querySelector(`li[data-session-id="${id}"]`);
}

function clickClose() {
  document.querySelector(".session-ctx-menu .smore-item.smore-danger").click();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("closing a chat from the sidebar menu", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    markExitingMock.mockClear();
  });

  it("does not start the row's exit while the discard confirm is open, and a Cancel keeps the chat", async () => {
    stateMock.sessions = [{ session_id: "busy-1", busy: true, cwd: "/repo", kind: "interactive" }];
    openCtxMenu("busy-1", mountRow("busy-1"));

    clickClose();
    await flush();

    expect(document.querySelector(".app-confirm-title")?.textContent).toContain("A turn is in progress");
    expect(markExitingMock).not.toHaveBeenCalled();

    document.querySelector(".app-confirm-cancel").click();
    await flush();

    expect(markExitingMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("clear_session", expect.anything());
  });

  it("still closes the busy chat once Discard is confirmed", async () => {
    stateMock.sessions = [{ session_id: "busy-2", busy: true, cwd: "/repo", kind: "interactive" }];
    openCtxMenu("busy-2", mountRow("busy-2"));

    clickClose();
    await flush();
    document.querySelector(".app-confirm-ok").click();
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("cancel_turn", { sessionId: "busy-2" });
    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "busy-2" });
  });

  it("starts the exit animation immediately for an idle chat, which closes with no confirm", async () => {
    stateMock.sessions = [{ session_id: "idle-1", busy: false, cwd: "/repo", kind: "interactive" }];
    openCtxMenu("idle-1", mountRow("idle-1"));

    clickClose();
    await flush();

    expect(markExitingMock).toHaveBeenCalledWith(document.querySelector("#sessions-list"), "idle-1");
    expect(document.querySelector(".app-confirm-overlay")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "idle-1" });
  });
});
