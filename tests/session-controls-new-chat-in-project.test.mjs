// @vitest-environment jsdom
// asserts: src/views/sessions/session-controls.ts
//
// The palette's "New chat in <project>" starts the chat in the mounted pane, or,
// when the Chats view is not mounted, queues a launch (project plus resolved
// config) for the next mount and switches to the view.

import { describe, it, expect, vi, beforeEach } from "vitest";

const startNewSessionInProject = vi.fn(async () => {});
const showView = vi.fn();
const resolveRememberedLocation = vi.fn(() => ({ path: "/repo", name: "repo" }));
const resolveNewChatConfig = vi.fn(async () => ({ model: "opus", effort: "high" }));

vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/pending-flow.ts", () => ({
  startNewSession: vi.fn(async () => {}),
  startNewSessionWithFavorite: vi.fn(async () => {}),
  startNewSessionInProject,
  resumeDraft: vi.fn(async () => {}),
  resumeParkedDraft: vi.fn(async () => {}),
}));
vi.mock("../src/views/sessions/location-picker.ts", () => ({ resolveRememberedLocation }));
vi.mock("../src/views/sessions/new-chat-config.ts", () => ({ resolveNewChatConfig }));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({ updateThinkingBar: vi.fn() }));
vi.mock("../src/shared/navigation.ts", () => ({ showView, getActiveView: vi.fn(() => "sessions") }));
vi.mock("../src/views/sessions/session-header.ts", () => ({ projectDashboardOpener: () => null }));
vi.mock("../src/views/sessions/project-dashboard/dashboard-page.ts", () => ({ openDashboardPage: vi.fn() }));
vi.mock("../src/views/sessions/permission-modal/index.ts", () => ({}));

const { startNewChatInProject, setPaneRef, consumePendingNewChat } = await import("../src/views/sessions/session-controls.ts");

const group = { name: "repo" };

beforeEach(() => {
  vi.clearAllMocks();
  setPaneRef(null);
  consumePendingNewChat();
});

describe("startNewChatInProject", () => {
  it("starts the chat in the mounted pane and queues nothing", async () => {
    const pane = document.createElement("div");
    setPaneRef(pane);
    await startNewChatInProject(group);
    expect(startNewSessionInProject).toHaveBeenCalledWith(pane, group);
    expect(consumePendingNewChat()).toBeNull();
    expect(showView).not.toHaveBeenCalled();
  });

  it("queues the project with its resolved config and opens the Chats view when no pane is mounted", async () => {
    await startNewChatInProject(group);
    expect(startNewSessionInProject).not.toHaveBeenCalled();
    expect(resolveNewChatConfig).toHaveBeenCalledWith("/repo", null);
    expect(showView).toHaveBeenCalledWith("sessions");
    expect(consumePendingNewChat()).toEqual({
      project: { path: "/repo", name: "repo" },
      config: { model: "opus", effort: "high" },
    });
  });
});
