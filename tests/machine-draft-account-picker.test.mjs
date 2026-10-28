// @vitest-environment jsdom
// A draft aimed at a paired machine picks its account from THAT machine's list:
// account ids are per machine, so offering the local list stored a local id
// into a peer draft. A peer with no accounts must not leave the draft unsendable.

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
const apiMock = vi.hoisted(() => ({
  listMachineAccounts: vi.fn(),
  listMachines: vi.fn(async () => ({ peers: [{ machine_id: "m1", label: "Laptop" }] })),
  listAccounts: vi.fn(async () => [{ id: "local-1", label: "local", icon: "user", colour: "#000" }]),
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => toast);
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
const { accountPickNeeded } = await import("../src/views/sessions/new-chat-config.ts");
const { openChangeAccountModal } = await import("../src/shared/change-account-modal.ts");
const { state } = await import("../src/views/sessions/state.ts");

const peerAccounts = [
  { id: "peer-1", label: "laptop-main", icon: "user", colour: "#111", email: "", subscription_tier: "max" },
  { id: "peer-2", label: "laptop-work", icon: "user", colour: "#222", email: "", subscription_tier: "pro" },
];
const list = (accounts, def = null) => ({ accounts, default_account_id: def, project_account_id: null });

async function mount(config) {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="session-statusbar-host"></div>`;
  await mountPendingStatusbar(pane, { path: "C:/p", name: "p" }, config, "ph-1", null);
}

describe("account pick for a draft aimed at a paired machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.renderer = null;
    state.pendingNewSession = null;
    modal.pick = "peer-2";
  });

  it("lists the peer's accounts and never the local ones", async () => {
    apiMock.listMachineAccounts.mockResolvedValue(list(peerAccounts));
    const config = { model: "", effort: "high", accountId: null, machineId: "m1" };
    await mount(config);
    await sbOpts.current.onAccountClick();
    await vi.waitFor(() => expect(openChangeAccountModal).toHaveBeenCalled());
    expect(apiMock.listMachineAccounts).toHaveBeenCalledWith("m1", "C:/p");
    expect(openChangeAccountModal.mock.calls[0][0].accounts.map((a) => a.id)).toEqual(["peer-1", "peer-2"]);
    expect(apiMock.listAccounts).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(config.accountId).toBe("peer-2"));
  });

  it("opens no picker, and keeps the draft, when the peer cannot be read", async () => {
    apiMock.listMachineAccounts.mockRejectedValue(new Error("offline"));
    const config = { model: "", effort: "high", accountId: null, machineId: "m1" };
    await mount(config);
    await sbOpts.current.onAccountClick();
    await vi.waitFor(() => expect(toast.showToast).toHaveBeenCalled());
    expect(toast.showToast.mock.calls[0][0]).toContain("Laptop");
    expect(openChangeAccountModal).not.toHaveBeenCalled();
    expect(config.accountId).toBeNull();
  });

  it("leaves a local draft on the modal's own (local) list", async () => {
    const config = { model: "", effort: "high", accountId: null };
    await mount(config);
    await sbOpts.current.onAccountClick();
    await vi.waitFor(() => expect(openChangeAccountModal).toHaveBeenCalled());
    expect(openChangeAccountModal.mock.calls[0][0].accounts).toBeUndefined();
    expect(apiMock.listMachineAccounts).not.toHaveBeenCalled();
  });

  it("lets a draft for a zero-account peer send without a pick", async () => {
    apiMock.listMachineAccounts.mockResolvedValue(list([]));
    const config = { model: "", effort: "high", accountId: null, machineId: "m1" };
    expect(await accountPickNeeded(config, "C:/p")).toBe(false);
  });
});
