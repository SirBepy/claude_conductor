// @vitest-environment jsdom
// Edges of a new-chat draft's account pick and schedule, driven through the
// real composer wiring and the real changePendingAccount:
//  - a pick made while start_session is pending is held and applied as a move
//    once the session id arrives (the renderer only swaps ids after that, so
//    "renderer still on the placeholder" does not mean "not sent yet");
//  - a draft aimed at a paired machine cannot be scheduled (ScheduledKind::NewChat
//    has no machine id, so it would spawn locally with the peer's cwd);
//  - the "Now on X" toast names a peer account from the peer's list.

import { describe, it, expect, vi, beforeEach } from "vitest";

const composerOpts = { current: null };
vi.mock("../src/shared/chat/composer.ts", () => ({
  Composer: vi.fn().mockImplementation((_el, opts) => {
    composerOpts.current = opts;
    return { destroy: vi.fn(), setSessionId: vi.fn(), getDraftBlocks: vi.fn(), isDraftEmpty: vi.fn(), isComposing: vi.fn(), clearComposer: vi.fn(), focus: vi.fn() };
  }),
}));
vi.mock("../src/shared/chat/held-messages.ts", () => ({
  HeldMessages: vi.fn().mockImplementation(() => ({ attach: vi.fn(), renameSession: vi.fn() })),
}));
const startSession = { resolve: null, reject: null };
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ipc);
const modal = { pick: "peer-2" };
vi.mock("../src/shared/change-account-modal.ts", () => ({ openChangeAccountModal: vi.fn(async () => modal.pick) }));
const applyAccountMove = vi.fn(async () => {});
vi.mock("../src/views/sessions/active-session-account.ts", () => ({ applyAccountMove, changeAccountForSession: vi.fn() }));
vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession: vi.fn() }));
vi.mock("../src/shared/chat/rate-limit-banner.ts", () => ({
  capitalize: (s) => s,
  getCachedAccount: vi.fn(() => ({ label: "LocalCacheLabel" })),
}));
const apiMock = vi.hoisted(() => ({
  moveSessionToAccount: vi.fn(async (id) => id),
  listMachineAccounts: vi.fn(),
  listMachines: vi.fn(async () => ({ peers: [{ machine_id: "m1", label: "Laptop" }] })),
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => toast);
vi.mock("../src/views/sessions/pending-draft-storage.ts", () => ({ savePendingSession: vi.fn(), clearPendingSession: vi.fn() }));
vi.mock("../src/views/sessions/new-chat-config.ts", () => ({
  accountPickNeeded: vi.fn(async () => false),
  noAccountsRegistered: vi.fn(async () => false),
  persistNewChatChoice: vi.fn(async () => {}),
  liveTakenCharacterIds: vi.fn(() => new Set()),
}));
vi.mock("../src/shared/navigation.ts", () => ({ showView: vi.fn() }));
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({ sendWithFailureRecovery: vi.fn() }));
vi.mock("../src/views/sessions/project-dashboard/draft-dashboard.ts", () => ({ leaveDraftDashboard: vi.fn() }));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({
  isCurrentSessionBusy: vi.fn(() => false),
  updateThinkingBar: vi.fn(),
  syncThinkingBar: vi.fn(),
}));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: { subscribe: vi.fn(() => () => {}), pushSynthetic: vi.fn(), removeSynthetic: vi.fn() },
}));
vi.mock("../src/shared/chat/chat-renderer.ts", () => ({ ChatRenderer: vi.fn() }));
vi.mock("../src/views/sessions/code-mode/entry.ts", () => ({ setCodeModeChatProvider: vi.fn() }));
vi.mock("../src/views/sessions/code-mode/session-chat.ts", () => ({ sessionCodeModeChat: vi.fn() }));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ renderSidebar: vi.fn(), refreshSessions: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/session-characters.ts", () => ({ characterIconUrl: vi.fn(() => "") }));
vi.mock("../src/shared/projects.ts", () => ({
  hydrateCharacterAvatars: vi.fn(async () => {}),
  hydrateProjectTechIcons: vi.fn(async () => {}),
}));
vi.mock("../src/views/sessions/permission-modal.ts", () => ({ setAutoAccept: vi.fn() }));
vi.mock("../src/views/sessions/session-header.ts", () => ({ SessionHeader: vi.fn() }));
vi.mock("../src/views/sessions/mobile-header-merge.ts", () => ({ applyHeaderMerge: vi.fn() }));
vi.mock("../src/views/sessions/session-statusbar.ts", () => ({
  SessionStatusbar: vi.fn(),
  loadStatuslineRows: vi.fn(async () => []),
  loadStatuslineHideZero: vi.fn(async () => false),
  fetchGitInfo: vi.fn(() => new Promise(() => {})),
}));

const { wirePendingComposer } = await import("../src/views/sessions/pending-pane-composer.ts");
const { changePendingAccount } = await import("../src/views/sessions/pending-pane-mount.ts");
const { state } = await import("../src/views/sessions/state.ts");

const peerAccounts = [
  { id: "peer-1", label: "laptop-main", icon: "user", colour: "#111", email: "", subscription_tier: "max" },
  { id: "peer-2", label: "laptop-work", icon: "user", colour: "#222", email: "", subscription_tier: "pro" },
];
const text = (t) => [{ type: "text", text: t }];

let rendererId;
function wire(config) {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="session-composer"></div>`;
  const deps = { rebindPaneHeader: vi.fn(), pickAccount: vi.fn() };
  wirePendingComposer(pane, "ph-1", { path: "C:/p", name: "p" }, config, state.mountId, deps);
  return deps;
}

describe("machine draft account pick and schedule edges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modal.pick = "peer-2";
    startSession.resolve = null;
    rendererId = "ph-1";
    state.selectedId = "ph-1";
    state.pendingNewSession = null;
    state.renderer = {
      currentSessionId: () => rendererId,
      swapSubscription: vi.fn(async (id) => { rendererId = id; }),
    };
    apiMock.listMachineAccounts.mockResolvedValue({ accounts: peerAccounts, default_account_id: "peer-1", project_account_id: null });
    ipc.invoke.mockImplementation((cmd) => {
      if (cmd === "start_session") return new Promise((res, rej) => { startSession.resolve = res; startSession.reject = rej; });
      return Promise.resolve({ fire_at: "2026-11-01T00:00:00Z" });
    });
  });

  it("applies an account picked while start_session is pending as a move once the id arrives", async () => {
    const config = { model: "", effort: "high", accountId: "peer-1", machineId: "m1" };
    wire(config);
    const sent = composerOpts.current.onSend(text("hi"));
    await vi.waitFor(() => expect(startSession.resolve).not.toBeNull());
    await changePendingAccount(config, "ph-1", "C:/p");
    expect(apiMock.moveSessionToAccount).not.toHaveBeenCalled();
    // The spawn has already taken the old account; the draft's config is spent.
    expect(config.accountId).toBe("peer-1");
    startSession.resolve("real-1");
    await sent;
    expect(apiMock.moveSessionToAccount).toHaveBeenCalledWith("real-1", "peer-2");
    expect(applyAccountMove).toHaveBeenCalledWith("real-1", "real-1", expect.anything());
    startSession.resolve = null;
  });

  it("still applies the held pick when the pane unmounts during the post-spawn session refresh", async () => {
    const { refreshSessions } = await import("../src/views/sessions/sidebar.ts");
    refreshSessions.mockImplementationOnce(async () => { state.mountId += 1; });
    const config = { model: "", effort: "high", accountId: "peer-1", machineId: "m1" };
    wire(config);
    const sent = composerOpts.current.onSend(text("hi"));
    await vi.waitFor(() => expect(startSession.resolve).not.toBeNull());
    await changePendingAccount(config, "ph-1", "C:/p");
    startSession.resolve("real-1");
    await sent;
    expect(apiMock.moveSessionToAccount).toHaveBeenCalledWith("real-1", "peer-2");
    startSession.resolve = null;
  });

  it("drops a pick held during a spawn that failed, and moves nothing", async () => {
    const config = { model: "", effort: "high", accountId: "peer-1", machineId: "m1" };
    wire(config);
    const sent = composerOpts.current.onSend(text("hi"));
    await vi.waitFor(() => expect(startSession.resolve).not.toBeNull());
    await changePendingAccount(config, "ph-1", "C:/p");
    startSession.reject(new Error("spawn failed"));
    await expect(sent).rejects.toThrow();
    expect(apiMock.moveSessionToAccount).not.toHaveBeenCalled();
    startSession.resolve = null;
  });

  it("names a peer account from the peer's list in the promoted-branch toast", async () => {
    const config = { model: "", effort: "high", accountId: "peer-1", machineId: "m1" };
    // The first send promotes the draft while the picker is open.
    const { openChangeAccountModal } = await import("../src/shared/change-account-modal.ts");
    openChangeAccountModal.mockImplementationOnce(async () => {
      rendererId = "real-1";
      return "peer-2";
    });
    await changePendingAccount(config, "ph-1", "C:/p");
    expect(apiMock.moveSessionToAccount).toHaveBeenCalledWith("real-1", "peer-2");
    expect(toast.showToast).toHaveBeenCalledWith("Now on laptop-work.");
  });

  it("refuses to schedule a draft aimed at a paired machine", async () => {
    const config = { model: "", effort: "high", accountId: "peer-1", machineId: "m1" };
    wire(config);
    await expect(composerOpts.current.onSchedule(text("later"), "2026-11-01T00:00:00Z", null)).rejects.toThrow();
    expect(ipc.invoke).not.toHaveBeenCalledWith("schedule_create", expect.anything());
    expect(toast.showToast).toHaveBeenCalled();
    expect(toast.showToast.mock.calls[0][0]).toMatch(/another machine/);
  });

  it("still schedules a local draft", async () => {
    const config = { model: "", effort: "high", accountId: "local-1" };
    wire(config);
    await composerOpts.current.onSchedule(text("later"), "2026-11-01T00:00:00Z", null);
    expect(ipc.invoke).toHaveBeenCalledWith("schedule_create", expect.objectContaining({ prompt: "later" }));
  });
});
