// @vitest-environment jsdom
// The composer's pickAccount hook (used when a send needs an account) must hand
// changePendingAccount the project path: a machine draft loads the peer's account
// list by cwd, and the state.pendingNewSession fallback is null for a draft that
// was never parked.

import { describe, it, expect, vi } from "vitest";

const changePendingAccount = vi.fn(async () => {});
vi.mock("../src/views/sessions/pending-pane-mount.ts", () => ({
  mountPendingChrome: vi.fn(() => null),
  mountPendingStatusbar: vi.fn(async () => {}),
  attachPendingRenderer: vi.fn(async () => {}),
  changePendingAccount,
}));
const composerDeps = { current: null };
vi.mock("../src/views/sessions/pending-pane-composer.ts", () => ({
  wirePendingComposer: vi.fn((_pane, _id, _project, _config, _mount, deps) => { composerDeps.current = deps; }),
}));
vi.mock("../src/views/sessions/project-dashboard/draft-dashboard.ts", () => ({
  mountDraftDashboard: vi.fn(),
  unmountDraftDashboard: vi.fn(),
}));
vi.mock("../src/views/sessions/active-session-mount.ts", () => ({ wireRenderer: vi.fn() }));
vi.mock("../src/views/sessions/chat-pane-cache.ts", () => ({ retainChat: vi.fn() }));
vi.mock("../src/views/sessions/session-header.ts", () => ({ SessionHeader: vi.fn(), projectDashboardOpener: vi.fn() }));
vi.mock("../src/views/sessions/permission-modal.ts", () => ({
  isAutoAccept: vi.fn(), isWrapUpOnDone: vi.fn(), setWrapUpOnDone: vi.fn(), rerenderSidebar: vi.fn(),
}));
vi.mock("../src/views/sessions/session-characters.ts", () => ({ characterForSession: vi.fn(), characterIconUrl: vi.fn() }));
vi.mock("../src/shared/projects.ts", () => ({
  hydrateCharacterAvatars: vi.fn(), hydrateProjectTechIcons: vi.fn(),
}));

const { renderPendingPane } = await import("../src/views/sessions/pending-pane.ts");

describe("renderPendingPane account picker hook", () => {
  it("passes the project path to changePendingAccount", async () => {
    const config = { model: "", effort: "high", accountId: null, machineId: "m1" };
    await renderPendingPane(document.createElement("div"), "ph-1", { path: "C:/p", name: "p" }, config);
    composerDeps.current.pickAccount();
    expect(changePendingAccount).toHaveBeenCalledWith(config, "ph-1", "C:/p");
  });
});
