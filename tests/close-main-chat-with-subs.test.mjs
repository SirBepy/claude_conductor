// Closing a main chat that still has a sub running: the daemon holds the close and
// asks Joe on a card (wait for them, close them too, keep it open). So the menu's
// Close must not start the row's exit animation, must not fire `cc:session-closed`
// while the daemon reports the close as held, and must not play the death cue. A
// main chat whose subs have all finished closes as any chat does.

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, markExitingMock, playSlotMock, stateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
  markExitingMock: vi.fn(),
  playSlotMock: vi.fn(async () => undefined),
  stateMock: { sessions: [], selectedId: null, activeChatActions: null, renderer: null },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/api.ts", () => ({ api: { playCharacterSlot: playSlotMock } }));
vi.mock("../src/shared/http-transport.ts", () => ({
  RemoteUnavailableError: class RemoteUnavailableError extends Error {},
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
vi.mock("../src/views/sessions/permission-modal", () => ({
  isAutoAccept: () => false,
  setAutoAccept: () => {},
  autoAcceptParked: () => {},
  isWrapUpOnDone: () => false,
  isSubchatsOn: () => false,
  setWrapUpOnDone: () => {},
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadHiddenSessions: () => new Set(),
  saveHiddenSessions: () => {},
  loadHiddenCollapsed: () => false,
  saveHiddenCollapsed: () => {},
  toggleSegCollapse: () => {},
  isMirrored: (i) => i?.machine != null,
  isSubchat: (i) => i?.subchat_of != null,
}));
vi.mock("../src/shared/chat/message-filter-pref.ts", () => ({
  isRawViewEnabled: () => false,
  setRawViewEnabled: () => {},
}));
vi.mock("../src/views/sessions/state.ts", () => ({ state: stateMock }));
vi.mock("../src/views/sessions/session-characters.ts", () => ({ characterForSession: () => "char-1" }));
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
const { closeChat, closeNeedsApproval } = await import("../src/views/sessions/close-chat.ts");

function mountRow(id) {
  document.body.innerHTML = `<ul id="sessions-list"><li data-session-id="${id}"><span>${id}</span></li></ul>`;
  return document.querySelector(`li[data-session-id="${id}"]`);
}

function clickClose() {
  document.querySelector(".session-ctx-menu .smore-item.smore-danger").click();
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = (extra = {}) => ({ session_id: "main", busy: false, cwd: "/repo", kind: "interactive", ended_at: null, ...extra });
const sub = (id, extra = {}) => ({ session_id: id, subchat_of: "main", subchat_finished: false, ended_at: null, ...extra });

describe("closing a main chat with subs", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => undefined);
    markExitingMock.mockClear();
    playSlotMock.mockClear();
    document.body.innerHTML = "";
  });

  it("needs the daemon's approval only while a sub is running", () => {
    stateMock.sessions = [main(), sub("a"), sub("b", { subchat_finished: true })];
    expect(closeNeedsApproval("main")).toBe(true);
    stateMock.sessions = [main(), sub("b", { subchat_finished: true }), sub("c", { ended_at: "2026-11-05T00:00:00Z" })];
    expect(closeNeedsApproval("main")).toBe(false);
    stateMock.sessions = [main()];
    expect(closeNeedsApproval("main")).toBe(false);
    expect(closeNeedsApproval("a-sub-is-not-a-main-chat")).toBe(false);
  });

  it("the menu's Close keeps the row, plays no death cue and does not report the chat closed while the daemon holds it", async () => {
    stateMock.sessions = [main(), sub("a")];
    invokeMock.mockImplementation(async (cmd) => (cmd === "clear_session" ? true : undefined));
    const closed = vi.fn();
    document.addEventListener("cc:session-closed", closed);
    openCtxMenu("main", mountRow("main"));

    clickClose();
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "main" });
    expect(markExitingMock).not.toHaveBeenCalled();
    expect(playSlotMock).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    document.removeEventListener("cc:session-closed", closed);
  });

  it("a held close reported by the daemon alone (a sub the window had not seen yet) is still not a close", async () => {
    stateMock.sessions = [main()];
    invokeMock.mockImplementation(async (cmd) => (cmd === "clear_session" ? true : undefined));
    const closed = vi.fn();
    document.addEventListener("cc:session-closed", closed);
    await closeChat("main");
    expect(closed).not.toHaveBeenCalled();
    document.removeEventListener("cc:session-closed", closed);
  });

  it("closes as before when every sub has finished", async () => {
    stateMock.sessions = [main(), sub("a", { subchat_finished: true })];
    const closed = vi.fn();
    document.addEventListener("cc:session-closed", closed);
    openCtxMenu("main", mountRow("main"));

    clickClose();
    await flush();

    expect(markExitingMock).toHaveBeenCalledWith(document.querySelector("#sessions-list"), "main");
    expect(playSlotMock).toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
    document.removeEventListener("cc:session-closed", closed);
  });
});
