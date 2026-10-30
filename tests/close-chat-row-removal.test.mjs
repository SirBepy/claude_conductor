// Closing the active chat (Ctrl+W, or the chat-menu "Close session") must
// remove its row from the sidebar the moment the backend confirms the close -
// not just deselect it. Pins two things: a stale "cc:session-closed" listener
// left over from an unmounted view (state.mountId has since advanced) must not
// touch the CURRENT view's pane/list, and a refreshSessions() backstop re-pulls
// the daemon's cached_instances so the row can't survive the optimistic filter
// if something else raced it.

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { stateMock, renderSidebarMock, refreshSessionsMock } = vi.hoisted(() => ({
  stateMock: {
    sessions: [],
    selectedId: null,
    mountId: 1,
    renderer: null,
    composer: null,
    pendingNewSession: null,
    daemonConnected: true,
    daemonSetupStalled: false,
  },
  renderSidebarMock: vi.fn(),
  refreshSessionsMock: vi.fn(async () => true),
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../src/shared/shortcuts.ts", () => ({
  register: vi.fn(),
  unregister: vi.fn(),
  onModifierHint: vi.fn(() => () => {}),
}));
vi.mock("../src/views/sessions/preview-panel.ts", () => ({ mountPreviewTab: vi.fn() }));
vi.mock("../src/views/sessions/fab-dial.ts", () => ({ mountFabDial: vi.fn() }));
vi.mock("../src/views/sessions/mobile-header-merge.ts", () => ({ initHeaderMerge: vi.fn() }));
vi.mock("../src/views/sessions/pending-flow.ts", () => ({
  startNewSession: vi.fn(),
  launchNewSession: vi.fn(),
  discardDraft: vi.fn(),
  resumeDraft: vi.fn(),
  resumeParkedDraft: vi.fn(),
}));
vi.mock("../src/shared/chat/composer.ts", () => ({ discardComposerDraft: vi.fn() }));
vi.mock("../src/views/sessions/pending-draft-storage.ts", () => ({ saveParkedDrafts: vi.fn() }));
vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession: vi.fn() }));
vi.mock("../src/views/sessions/state.ts", () => ({
  state: stateMock,
  setActiveSession: vi.fn((id) => { stateMock.selectedId = id; }),
  clearLastSelectedSession: vi.fn(),
}));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({ updateThinkingBar: vi.fn() }));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  paneEmptyStateHtml: () => '<div class="session-empty"></div>',
}));
vi.mock("../src/views/sessions/sidebar.ts", () => ({
  renderSidebar: renderSidebarMock,
  refreshSessions: refreshSessionsMock,
  openCtxMenu: vi.fn(),
  openDraftCtxMenu: vi.fn(),
}));
vi.mock("../src/views/sessions/when-done.ts", () => ({
  initWhenDone: vi.fn(async () => () => {}),
  subscribeWhenDone: vi.fn(() => () => {}),
}));
vi.mock("../src/views/sessions/view-more-menu.ts", () => ({
  closeViewMoreMenu: vi.fn(),
  refreshViewMoreIndicator: vi.fn(),
  rerenderViewMenuProtocol: vi.fn(),
  toggleViewMoreMenu: vi.fn(),
}));
vi.mock("../src/views/sessions/session-controls.ts", () => ({
  selectSessionByIndex: vi.fn(),
  closeFocusedChat: vi.fn(),
  triggerNewSessionFavoriteGlobal: vi.fn(),
}));

const { wireDocumentListeners } = await import("../src/views/sessions/sessions-dom-wiring.ts");

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = "";
  stateMock.sessions = [{ session_id: "s-1" }, { session_id: "s-2" }];
  stateMock.selectedId = "s-1";
  stateMock.mountId = 1;
  stateMock.renderer = null;
  stateMock.composer = null;
  renderSidebarMock.mockClear();
  refreshSessionsMock.mockClear();
});

describe("cc:session-closed", () => {
  it("drops the closed session from state and re-renders, then re-pulls the authoritative list", async () => {
    const pane = document.createElement("div");
    const listEl = document.createElement("ul");
    wireDocumentListeners(pane, listEl, 1);

    document.dispatchEvent(new CustomEvent("cc:session-closed", { detail: { sessionId: "s-1" } }));

    expect(stateMock.selectedId).toBeNull();
    expect(stateMock.sessions.map((s) => s.session_id)).toEqual(["s-2"]);
    expect(renderSidebarMock).toHaveBeenCalledWith(listEl);
    expect(pane.querySelector(".session-empty")).not.toBeNull();

    await flush();
    expect(refreshSessionsMock).toHaveBeenCalled();
    // Re-rendered a second time off the backstop refresh, not just the
    // optimistic filter.
    expect(renderSidebarMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores the event once the view has remounted (state.mountId moved on)", async () => {
    const pane = document.createElement("div");
    const listEl = document.createElement("ul");
    wireDocumentListeners(pane, listEl, 1);

    stateMock.mountId = 2; // a newer mount took over; this listener is stale

    document.dispatchEvent(new CustomEvent("cc:session-closed", { detail: { sessionId: "s-1" } }));
    await flush();

    expect(stateMock.selectedId).toBe("s-1");
    expect(stateMock.sessions.map((s) => s.session_id)).toEqual(["s-1", "s-2"]);
    expect(renderSidebarMock).not.toHaveBeenCalled();
    expect(refreshSessionsMock).not.toHaveBeenCalled();
  });

  it("ignores the event when the closed session isn't the selected one", async () => {
    const pane = document.createElement("div");
    const listEl = document.createElement("ul");
    wireDocumentListeners(pane, listEl, 1);

    document.dispatchEvent(new CustomEvent("cc:session-closed", { detail: { sessionId: "s-2" } }));
    await flush();

    expect(stateMock.selectedId).toBe("s-1");
    expect(renderSidebarMock).not.toHaveBeenCalled();
  });
});
