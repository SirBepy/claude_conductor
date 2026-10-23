// Ctrl+W on the Projects tab hides the selected project instead of closing a
// chat. The tab keeps selectedId null, so without the hook the shortcut would do
// nothing there; with a chat showing it must keep its confirm-and-close path.

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const askConfirm = vi.fn(async () => true);
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm }));

const closeChatWithConfirm = vi.fn(async () => {});
vi.mock("../src/views/sessions/close-chat.ts", () => ({ closeChatWithConfirm }));

vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession: vi.fn() }));
vi.mock("../src/views/sessions/pending-flow.ts", () => ({
  startNewSession: vi.fn(),
  startNewSessionWithFavorite: vi.fn(),
  resumeDraft: vi.fn(),
  resumeParkedDraft: vi.fn(),
}));
vi.mock("../src/views/sessions/pending-draft-storage.ts", () => ({ saveParkedDrafts: vi.fn() }));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({ updateThinkingBar: vi.fn() }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: vi.fn() }));
vi.mock("../src/views/sessions/permission-modal.ts", () => ({
  isWrapUpOnDone: vi.fn(() => false),
  setWrapUpOnDone: vi.fn(),
  rerenderSidebar: vi.fn(),
}));
vi.mock("../src/views/sessions/session-header.ts", () => ({ refreshWrapUpIndicator: vi.fn() }));

const { state } = await import("../src/views/sessions/state.ts");
const { closeFocusedChat } = await import("../src/views/sessions/session-controls.ts");

beforeEach(() => {
  vi.clearAllMocks();
  state.selectedId = null;
  state.pendingNewSession = null;
  state.dashboardOpen = false;
  state.onCloseProject = null;
});

describe("closeFocusedChat on the Projects tab", () => {
  it("runs the tab's close hook, with no confirm and no chat close", () => {
    const hook = vi.fn();
    state.dashboardOpen = true;
    state.onCloseProject = hook;

    closeFocusedChat();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(askConfirm).not.toHaveBeenCalled();
    expect(closeChatWithConfirm).not.toHaveBeenCalled();
  });

  it("leaves a chat's Ctrl+W alone once the tab is no longer showing", () => {
    state.dashboardOpen = false;
    state.onCloseProject = vi.fn();
    state.selectedId = "real-1";

    closeFocusedChat();

    expect(state.onCloseProject).not.toHaveBeenCalled();
    expect(closeChatWithConfirm).toHaveBeenCalledWith("real-1");
  });
});
