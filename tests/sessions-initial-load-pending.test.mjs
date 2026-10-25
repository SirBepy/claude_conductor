// @vitest-environment jsdom
//
// A new chat and a dashboard both queued before the Sessions view mounts: the
// new chat launches (its draft already shows the project's dashboard) instead
// of the dashboard consuming the slot and the chat being dropped.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => true) }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ renderSidebar: vi.fn(), refreshSessions: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/sessions-wiring.ts", () => ({ refreshPaneEmptyState: vi.fn() }));
vi.mock("../src/views/sessions/session-characters.ts", () => ({ loadSessionCharacters: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({ updateThinkingBar: vi.fn() }));
vi.mock("../src/shared/chat/rate-limit-banner.ts", () => ({ rateLimitBanner: { update: vi.fn() } }));
vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/instances-cache.ts", () => ({ loadCachedInstances: vi.fn(() => null) }));

const launchNewSession = vi.fn(async () => {});
vi.mock("../src/views/sessions/pending-flow.ts", () => ({ launchNewSession }));
const openDashboardPage = vi.fn(async () => {});
vi.mock("../src/views/sessions/project-dashboard/dashboard-page.ts", () => ({ openDashboardPage }));

const queued = { dash: null, newChat: null };
vi.mock("../src/views/sessions/session-controls.ts", () => ({
  consumePendingNewChat: () => { const v = queued.newChat; queued.newChat = null; return v; },
  consumePendingDashboard: () => { const v = queued.dash; queued.dash = null; return v; },
  consumePendingHistoryResume: () => null,
}));

const { state } = await import("../src/views/sessions/state.ts");
const { initialLoadAndRestore } = await import("../src/views/sessions/sessions-initial-load.ts");

describe("initialLoadAndRestore with a chat and a dashboard both queued", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.mountId = 1;
    state.sessions = [];
    state.pendingNewSession = null;
  });

  it("launches the queued chat and drops the dashboard request", async () => {
    queued.newChat = { project: { path: "/p", name: "P" }, config: { model: "opus", effort: "high" } };
    queued.dash = { cwd: "/p", projectId: null };
    await initialLoadAndRestore(document.createElement("div"), document.createElement("div"), 1);

    expect(launchNewSession).toHaveBeenCalledTimes(1);
    expect(openDashboardPage).not.toHaveBeenCalled();
    expect(queued.dash).toBeNull();
  });

  it("opens the dashboard when only it is queued", async () => {
    queued.dash = { cwd: "/p", projectId: null };
    await initialLoadAndRestore(document.createElement("div"), document.createElement("div"), 1);

    expect(openDashboardPage).toHaveBeenCalledWith("/p", null);
    expect(launchNewSession).not.toHaveBeenCalled();
  });
});
