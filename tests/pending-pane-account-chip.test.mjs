// @vitest-environment jsdom
// The draft pane's statusbar account chip was display-only: mountPendingStatusbar
// passed no onAccountClick, so the chip never opened the picker, before the first
// send or after it (the pane is rebound in place on promotion, keeping that same
// statusbar). Before promotion the pick re-points the draft's config; after it,
// the click is the live chat's move-to-account.

import { describe, it, expect, vi, beforeEach } from "vitest";

const sbOpts = { current: null };
const sbInstance = { setAccountId: vi.fn() };
vi.mock("../src/views/sessions/session-statusbar.ts", () => ({
  SessionStatusbar: vi.fn().mockImplementation((_host, _x, _rows, opts) => {
    sbOpts.current = opts;
    return sbInstance;
  }),
  loadStatuslineRows: vi.fn(async () => []),
  loadStatuslineHideZero: vi.fn(async () => false),
  fetchGitInfo: vi.fn(() => new Promise(() => {})),
}));
const modal = { pick: "acc-b" };
vi.mock("../src/shared/change-account-modal.ts", () => ({
  openChangeAccountModal: vi.fn(async () => modal.pick),
}));
const changeAccountForSession = vi.fn(async () => {});
vi.mock("../src/views/sessions/active-session-account.ts", () => ({ changeAccountForSession }));
vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession: vi.fn() }));
vi.mock("../src/views/sessions/pending-draft-storage.ts", () => ({ savePendingSession: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../src/shared/api.ts", () => ({ api: {} }));
vi.mock("../src/shared/chat/chat-renderer.ts", () => ({ ChatRenderer: vi.fn() }));
vi.mock("../src/shared/chat/event-store.ts", () => ({ sessionEvents: { subscribe: vi.fn(() => () => {}) } }));
vi.mock("../src/views/sessions/code-mode/entry.ts", () => ({ setCodeModeChatProvider: vi.fn() }));
vi.mock("../src/views/sessions/code-mode/session-chat.ts", () => ({ sessionCodeModeChat: vi.fn() }));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({ syncThinkingBar: vi.fn() }));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ renderSidebar: vi.fn(), refreshSessions: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/session-characters.ts", () => ({ characterIconUrl: vi.fn(() => "") }));
vi.mock("../src/shared/projects.ts", () => ({
  hydrateCharacterAvatars: vi.fn(async () => {}),
  hydrateProjectTechIcons: vi.fn(async () => {}),
}));
vi.mock("../src/views/sessions/permission-modal.ts", () => ({ setAutoAccept: vi.fn() }));
vi.mock("../src/views/sessions/session-header.ts", () => ({ SessionHeader: vi.fn() }));
vi.mock("../src/views/sessions/mobile-header-merge.ts", () => ({ applyHeaderMerge: vi.fn() }));

const { mountPendingStatusbar } = await import("../src/views/sessions/pending-pane-mount.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { savePendingSession } = await import("../src/views/sessions/pending-draft-storage.ts");

async function mount(config) {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="session-statusbar-host"></div>`;
  await mountPendingStatusbar(pane, { path: "C:/p", name: "p" }, config, "ph-1", null);
}

describe("draft pane account chip", () => {
  beforeEach(() => {
    sbOpts.current = null;
    sbInstance.setAccountId.mockClear();
    changeAccountForSession.mockClear();
    savePendingSession.mockClear();
    modal.pick = "acc-b";
    state.renderer = null;
    state.pendingNewSession = null;
  });

  it("is clickable and re-points the unspawned draft's account", async () => {
    const config = { model: "", effort: "high", accountId: "acc-a" };
    state.pendingNewSession = { placeholderId: "ph-1", projectPath: "C:/p", projectName: "p", config: { ...config } };
    await mount(config);
    expect(typeof sbOpts.current.onAccountClick).toBe("function");
    state.renderer = { currentSessionId: () => "ph-1" };
    await sbOpts.current.onAccountClick();
    await vi.waitFor(() => expect(sbInstance.setAccountId).toHaveBeenCalledWith("acc-b"));
    expect(config.accountId).toBe("acc-b");
    expect(state.pendingNewSession.config.accountId).toBe("acc-b");
    expect(savePendingSession).toHaveBeenCalled();
    expect(changeAccountForSession).not.toHaveBeenCalled();
  });

  it("moves the live chat once the draft has been promoted", async () => {
    const config = { model: "", effort: "high", accountId: "acc-a" };
    await mount(config);
    state.renderer = { currentSessionId: () => "real-1" };
    sbOpts.current.onAccountClick();
    await vi.waitFor(() => expect(changeAccountForSession).toHaveBeenCalled());
    expect(changeAccountForSession.mock.calls[0][0]).toBe("real-1");
    expect(config.accountId).toBe("acc-a");
  });
});
