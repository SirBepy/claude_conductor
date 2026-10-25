// @vitest-environment jsdom
//
// Ctrl+Shift+D opens the focused chat's project dashboard, but a mirrored chat
// (Instance.machine set) carries a cwd that exists on another machine, so the
// shortcut must do nothing there, matching the header's project-name click.

import { describe, it, expect, vi, beforeEach } from "vitest";

const openDashboardPage = vi.fn(async () => {});
vi.mock("../src/views/sessions/project-dashboard/dashboard-page.ts", () => ({ openDashboardPage }));
vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/pending-flow.ts", () => ({
  startNewSession: vi.fn(async () => {}),
  startNewSessionWithFavorite: vi.fn(async () => {}),
  resumeDraft: vi.fn(async () => {}),
  resumeParkedDraft: vi.fn(async () => {}),
}));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({ updateThinkingBar: vi.fn() }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: vi.fn(), getActiveView: vi.fn(() => "sessions") }));
vi.mock("../src/views/sessions/session-header.ts", () => ({
  refreshWrapUpIndicator: vi.fn(),
  projectDashboardOpener: (s) => {
    const cwd = s.cwd ? String(s.cwd) : "";
    if (!cwd || s.machine) return null;
    return () => { void openDashboardPage(cwd, s.project_id || null); };
  },
}));
vi.mock("../src/views/sessions/permission-modal/index.ts", () => ({
  isWrapUpOnDone: vi.fn(() => false), setWrapUpOnDone: vi.fn(), rerenderSidebar: vi.fn(),
}));

const { state } = await import("../src/views/sessions/state.ts");
const { openFocusedChatDashboard, setPaneRef } = await import("../src/views/sessions/session-controls.ts");

describe("openFocusedChatDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPaneRef(document.createElement("div"));
    state.pendingNewSession = null;
  });

  it("opens the dashboard for a local chat", () => {
    state.sessions = [{ session_id: "a", cwd: "/repo", project_id: null }];
    state.selectedId = "a";
    openFocusedChatDashboard();
    expect(openDashboardPage).toHaveBeenCalledWith("/repo", null);
  });

  it("does nothing for a mirrored chat", () => {
    state.sessions = [{ session_id: "a", cwd: "/remote/repo", project_id: null, machine: { id: "m", label: "Other" } }];
    state.selectedId = "a";
    openFocusedChatDashboard();
    expect(openDashboardPage).not.toHaveBeenCalled();
  });
});
