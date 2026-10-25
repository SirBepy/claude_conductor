// @vitest-environment jsdom
//
// A slow dashboard open (its dashboard_list_targets await) must not mount over
// a chat the user picked from the sidebar while it was still resolving.

import { describe, it, expect, vi, beforeEach } from "vitest";

const dismountActivePane = vi.fn();
vi.mock("../src/views/sessions/active-session.ts", () => ({ dismountActivePane, selectSession: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/pending-flow.ts", () => ({ resumeDraft: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({ paneEmptyStateHtml: () => "" }));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ renderSidebar: vi.fn() }));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({ updateThinkingBar: vi.fn() }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));

const mountDashboard = vi.fn(() => ({ root: document.createElement("div"), chips: document.createElement("div"), destroy: vi.fn() }));
vi.mock("../src/views/sessions/project-dashboard/dashboard.ts", () => ({ mountDashboard }));

let release;
const resolveTarget = vi.fn(() => new Promise((res) => { release = () => res({ kind: "project", id: "/p" }); }));
vi.mock("../src/views/sessions/project-dashboard/draft-dashboard.ts", () => ({ resolveTarget }));

const { state, setActiveSession } = await import("../src/views/sessions/state.ts");
const { openDashboardPage } = await import("../src/views/sessions/project-dashboard/dashboard-page.ts");

describe("openDashboardPage vs a chat picked during the target lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div class="view-sessions"><div id="session-pane"></div></div>';
    state.dashboardOpen = false;
    state.onChatActivated = null;
  });

  it("does not mount over the chat", async () => {
    const opening = openDashboardPage("/p");
    setActiveSession("chat-1");
    release();
    await opening;

    expect(mountDashboard).not.toHaveBeenCalled();
    expect(dismountActivePane).not.toHaveBeenCalled();
    expect(state.dashboardOpen).toBe(false);
    expect(state.selectedId).toBe("chat-1");
  });

  it("still mounts when nothing is picked meanwhile", async () => {
    const opening = openDashboardPage("/p");
    release();
    await opening;

    expect(mountDashboard).toHaveBeenCalledTimes(1);
    expect(state.dashboardOpen).toBe(true);
  });
});
