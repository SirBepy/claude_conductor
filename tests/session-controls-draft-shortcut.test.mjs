// @vitest-environment jsdom
//
// Regression for: "Ctrl+Num can't jump into a draft chat". selectSessionByIndex
// only ever called selectSession(realId), so an index resolving to a draft or
// parked-draft placeholder id silently no-oped. These mocks isolate
// session-controls.ts's own dispatch branch (draft vs parked vs real) from the
// heavier machinery selectSession/resumeDraft/resumeParkedDraft each drive.

import { describe, it, expect, vi, beforeEach } from "vitest";

const selectSession = vi.fn(async () => {});
vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession }));

const resumeDraft = vi.fn(async () => {});
const resumeParkedDraft = vi.fn(async () => {});
vi.mock("../src/views/sessions/pending-flow.ts", () => ({
  startNewSession: vi.fn(async () => {}),
  resumeDraft,
  resumeParkedDraft,
}));

const updateThinkingBar = vi.fn();
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({ updateThinkingBar }));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: vi.fn(), getActiveView: vi.fn(() => "sessions") }));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({ projectName: vi.fn(() => "") }));

const { state } = await import("../src/views/sessions/state.ts");
const { selectSessionByIndex, setPaneRef } = await import("../src/views/sessions/session-controls.ts");

function draftState(placeholderId, overrides = {}) {
  return {
    placeholderId,
    projectPath: "/proj",
    projectName: "Proj",
    config: { model: "opus", effort: "high" },
    realId: null,
    firstMessageSent: false,
    preExistingSessionIds: new Set(),
    firstMessageSentAt: null,
    ...overrides,
  };
}

describe("selectSessionByIndex routes drafts, parked drafts, and real sessions", () => {
  const pane = document.createElement("div");

  beforeEach(() => {
    vi.clearAllMocks();
    setPaneRef(pane);
    state.sessions = [];
    state.parkedDrafts = [];
    state.pendingNewSession = null;
    state.sortedSessionIds = [];
    state.composer = null;
  });

  it("resumes the unsent draft instead of calling selectSession", async () => {
    state.pendingNewSession = draftState("pending-1");
    state.sortedSessionIds = ["pending-1"];

    selectSessionByIndex(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(resumeDraft).toHaveBeenCalledWith(pane);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("navigates a 'starting...' pending row to its now-known realId", async () => {
    state.pendingNewSession = draftState("pending-1", { firstMessageSent: true, realId: "real-9" });
    state.sortedSessionIds = ["pending-1"];

    selectSessionByIndex(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(selectSession).toHaveBeenCalledWith("real-9", pane);
    expect(resumeDraft).not.toHaveBeenCalled();
    expect(updateThinkingBar).toHaveBeenCalled();
  });

  it("no-ops a 'starting...' row whose realId isn't known yet", () => {
    state.pendingNewSession = draftState("pending-1", { firstMessageSent: true, realId: null });
    state.sortedSessionIds = ["pending-1"];

    selectSessionByIndex(0);

    expect(selectSession).not.toHaveBeenCalled();
    expect(resumeDraft).not.toHaveBeenCalled();
  });

  it("resumes a parked draft via the shared helper and removes it from state.parkedDrafts", async () => {
    const parked = { placeholderId: "parked-1", projectPath: "/proj2", projectName: "Proj2", config: { model: "opus", effort: "high" } };
    state.parkedDrafts = [parked];
    state.sortedSessionIds = ["parked-1"];

    selectSessionByIndex(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(resumeParkedDraft).toHaveBeenCalledWith(pane, parked);
    expect(state.parkedDrafts.find((d) => d.placeholderId === "parked-1")).toBeUndefined();
  });

  it("falls through to selectSession for a real session id", () => {
    state.sortedSessionIds = ["real-1"];

    selectSessionByIndex(0);

    expect(selectSession).toHaveBeenCalledWith("real-1", pane);
    expect(resumeDraft).not.toHaveBeenCalled();
    expect(resumeParkedDraft).not.toHaveBeenCalled();
  });
});
