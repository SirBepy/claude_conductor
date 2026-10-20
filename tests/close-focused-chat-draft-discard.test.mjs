// Regression for: Ctrl+W on a not-yet-sent draft chat looked like it did
// nothing. closeFocusedChat always routed through closeChatWithConfirm's
// clear_session call, which is a no-op for a placeholder id with no real
// session behind it yet - unlike the X button and the 3-dot menu's "Delete
// draft", neither of which ever reach clear_session for a draft. Pins that
// closeFocusedChat now detects the draft case and dispatches the same
// "discard-pending-draft" event those other two paths use instead.

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

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.selectedId = null;
  state.pendingNewSession = null;
});

describe("closeFocusedChat", () => {
  it("discards an unsent draft instead of calling clear_session via closeChatWithConfirm", async () => {
    state.selectedId = "pending-1";
    state.pendingNewSession = { placeholderId: "pending-1" };
    const onDiscard = vi.fn();
    document.addEventListener("discard-pending-draft", onDiscard);

    closeFocusedChat();
    await flush();

    expect(askConfirm).toHaveBeenCalledWith("Close this chat?", expect.objectContaining({ focusConfirm: true }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(closeChatWithConfirm).not.toHaveBeenCalled();

    document.removeEventListener("discard-pending-draft", onDiscard);
  });

  it("does not discard the draft if the confirm is dismissed", async () => {
    state.selectedId = "pending-1";
    state.pendingNewSession = { placeholderId: "pending-1" };
    askConfirm.mockResolvedValueOnce(false);
    const onDiscard = vi.fn();
    document.addEventListener("discard-pending-draft", onDiscard);

    closeFocusedChat();
    await flush();

    expect(onDiscard).not.toHaveBeenCalled();

    document.removeEventListener("discard-pending-draft", onDiscard);
  });

  it("still routes a real (non-draft) session through closeChatWithConfirm", () => {
    state.selectedId = "real-1";
    state.pendingNewSession = null;

    closeFocusedChat();

    expect(closeChatWithConfirm).toHaveBeenCalledWith("real-1");
    expect(askConfirm).not.toHaveBeenCalled();
  });
});
