// @vitest-environment jsdom
// asserts: src/views/sessions/chat-menu-items.ts
// "Compact now" in the chat menu: a rare action, so menu only. It calls the
// daemon's compact_now for a main chat (Use subchats on) and is disabled, with
// the reason, for any other chat; a sub does not have it at all.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, toastMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), toastMock: vi.fn() }));
let remote = false;

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: toastMock }));
vi.mock("../src/shared/http-transport.ts", () => ({
  RemoteUnavailableError: class RemoteUnavailableError extends Error {},
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));
vi.mock("../src/views/sessions/permission-modal", () => ({
  isAutoAccept: () => false,
  setAutoAccept: () => {},
  autoAcceptParked: () => {},
  isSubchatsOn: () => false,
  setSubchatsOn: async () => {},
  rerenderSidebar: () => {},
}));
vi.mock("../src/views/sessions/permission-modal/dismiss-open-questions", () => ({ openQuestionCards: () => [] }));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadHiddenSessions: () => new Set(),
  saveHiddenSessions: () => {},
}));
vi.mock("../src/shared/chat/message-filter-pref.ts", () => ({ isRawViewEnabled: () => false, setRawViewEnabled: () => {} }));
vi.mock("../src/views/sessions/state.ts", () => ({ state: { renderer: null, statusbar: null, selectedId: "s1" } }));
vi.mock("../src/views/sessions/active-session-account.ts", () => ({
  changeCharacterForSession: vi.fn(),
  changeAccountForSession: vi.fn(),
}));
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({ sendWithFailureRecovery: vi.fn() }));
vi.mock("../src/shared/chat/event-store.ts", () => ({ sessionEvents: { pushSynthetic: vi.fn(), removeSynthetic: vi.fn() } }));

const { buildChatItems } = await import("../src/views/sessions/chat-menu-items.ts");

const ctx = (over = {}) => ({
  kind: "live", sessionId: "s1", cwd: "C:/p", pid: 1, readOnly: false, autoAcceptOn: false,
  subchatsOn: true, isHidden: false, ...over,
});
const find = (c) => buildChatItems(c).find((i) => i.label === "Compact now");

beforeEach(() => {
  remote = false;
  invokeMock.mockReset().mockResolvedValue({ ok: true });
  toastMock.mockReset();
});

describe("Compact now", () => {
  it("is in the chat menu and calls compact_now with the session id for a main chat", async () => {
    const item = find(ctx());
    expect(item).toBeTruthy();
    expect(item.disabledReason).toBeUndefined();
    await item.run();
    expect(invokeMock).toHaveBeenCalledWith("compact_now", { sessionId: "s1" });
    expect(toastMock).toHaveBeenCalledWith("Compacting this chat.");
  });

  it("shows the daemon's reason when it declines, and the error when the call fails", async () => {
    invokeMock.mockResolvedValueOnce({ ok: false, error: "Not compacted: the chat is busy." });
    await find(ctx()).run();
    expect(toastMock).toHaveBeenLastCalledWith("Not compacted: the chat is busy.");
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await find(ctx()).run();
    expect(toastMock.mock.calls.at(-1)[0]).toContain("boom");
  });

  it("is disabled for a chat that is not a main chat and never calls the RPC", () => {
    const item = find(ctx({ subchatsOn: false }));
    expect(item.run).toBeUndefined();
    expect(item.disabledReason).toMatch(/main chat/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("is disabled for a draft, a mirrored chat and on the phone", () => {
    expect(find(ctx({ kind: "draft", sessionId: null })).run).toBeUndefined();
    expect(find(ctx({ mirrored: true })).run).toBeUndefined();
    remote = true;
    const phone = find(ctx());
    expect(phone.run).toBeUndefined();
    expect(phone.disabledReason).toMatch(/phone/);
  });

  it("is not offered to a sub", () => {
    expect(find(ctx({ isSub: true }))).toBeUndefined();
  });
});
