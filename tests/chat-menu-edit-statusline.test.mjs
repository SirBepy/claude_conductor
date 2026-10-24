// @vitest-environment jsdom
// "Edit statusline" in the chat's ... menu: offered on desktop for the chat on
// screen, absent on the phone (which cannot save a layout).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { isRemoteMock, fakeState } = vi.hoisted(() => ({
  isRemoteMock: vi.fn(() => false),
  fakeState: { renderer: null, statusbar: null, selectedId: "s1" },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn() }));
vi.mock("../src/shared/http-transport.ts", () => ({
  RemoteUnavailableError: class RemoteUnavailableError extends Error {},
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: isRemoteMock }));
vi.mock("../src/views/sessions/permission-modal", () => ({
  isAutoAccept: () => false,
  setAutoAccept: () => {},
  autoAcceptParked: () => {},
  isWrapUpOnDone: () => false,
  setWrapUpOnDone: () => {},
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadHiddenSessions: () => new Set(),
  saveHiddenSessions: () => {},
}));
vi.mock("../src/shared/chat/message-filter-pref.ts", () => ({
  isRawViewEnabled: () => false,
  setRawViewEnabled: () => {},
}));
vi.mock("../src/views/sessions/state.ts", () => ({ state: fakeState }));
vi.mock("../src/views/sessions/active-session-account.ts", () => ({
  changeCharacterForSession: vi.fn(),
  changeAccountForSession: vi.fn(),
}));
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({
  sendWithFailureRecovery: vi.fn(),
}));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: { pushSynthetic: vi.fn(), removeSynthetic: vi.fn() },
}));

const { buildConfigureItems } = await import("../src/views/sessions/chat-menu-items.ts");

const ctx = (over = {}) => ({
  kind: "live", sessionId: "s1", cwd: "C:/p", pid: 1, readOnly: false, autoAcceptOn: false,
  wrapUpOnDoneOn: false, isHidden: false, ...over,
});
const find = (items) => items.find((i) => i.label === "Edit statusline");

beforeEach(() => {
  isRemoteMock.mockReturnValue(false);
  fakeState.statusbar = { beginLayoutEdit: vi.fn() };
  fakeState.selectedId = "s1";
});

describe("Edit statusline menu item", () => {
  it("runs beginLayoutEdit on the visible chat's bar", () => {
    const item = find(buildConfigureItems(ctx()));
    expect(item.icon).toBe("pencil-simple");
    expect(item.disabledReason).toBeUndefined();
    item.run();
    expect(fakeState.statusbar.beginLayoutEdit).toHaveBeenCalledOnce();
  });

  it("is absent on the phone", () => {
    isRemoteMock.mockReturnValue(true);
    expect(find(buildConfigureItems(ctx()))).toBeUndefined();
  });

  it("is disabled for a sidebar row that is not the chat on screen", () => {
    expect(find(buildConfigureItems(ctx({ sessionId: "other" }))).disabledReason).toBe("Open the chat first");
  });

  it("is available for a draft", () => {
    expect(find(buildConfigureItems(ctx({ kind: "draft", sessionId: null }))).disabledReason).toBeUndefined();
  });
});
