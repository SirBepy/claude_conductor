// @vitest-environment jsdom
// asserts: src/views/sessions/chat-menu-ctx.ts
//
// The header's overflow menu and the command palette share one ctx builder, so
// both offer the same "This chat" actions with the same disabled reasons.

import { describe, it, expect, vi, beforeEach } from "vitest";

const refreshDeployWorkflowCache = vi.fn(async () => {});
let remote = false;

vi.mock("../src/views/sessions/permission-modal/index.ts", () => ({
  isAutoAccept: (id) => id === "auto",
  isSubchatsOn: (id) => id === "subs",
}));
vi.mock("../src/views/sessions/subchats-gate.ts", () => ({
  subchatsBlockedReason: (accountId) => (accountId === "credit" ? "API credit account" : undefined),
}));
vi.mock("../src/views/sessions/deploy-workflow-gate.ts", () => ({
  cachedHasDeployWorkflow: (cwd) => (cwd === "/repo" ? true : undefined),
  refreshDeployWorkflowCache,
}));
vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => remote }));

const { state } = await import("../src/views/sessions/state.ts");
const { liveChatMenuCtx } = await import("../src/views/sessions/chat-menu-ctx.ts");

const sess = (id, extra = {}) => ({ session_id: id, cwd: "/repo", pid: 7, kind: "interactive", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  remote = false;
  state.sessions = [];
  state.activeChatActions = undefined;
  localStorage.clear();
});

describe("liveChatMenuCtx", () => {
  it("reads the chat's own row into the ctx", () => {
    state.sessions = [sess("a", { jarvis: true, frozen: true, pinned_to_sidebar: true, account_id: "credit" })];
    const ctx = liveChatMenuCtx("a");
    expect(ctx).toMatchObject({
      kind: "live",
      sessionId: "a",
      cwd: "/repo",
      pid: 7,
      readOnly: false,
      isSub: false,
      isPinned: true,
      isJarvis: true,
      isFrozen: true,
      isHidden: false,
      mirrored: false,
      hasDeployWorkflow: true,
      subchatsBlockedReason: "API credit account",
    });
  });

  it("takes the toggles from the permission gates, not the row", () => {
    state.sessions = [sess("auto"), sess("subs"), sess("plain")];
    expect(liveChatMenuCtx("auto")).toMatchObject({ autoAcceptOn: true, subchatsOn: false });
    expect(liveChatMenuCtx("subs")).toMatchObject({ autoAcceptOn: false, subchatsOn: true });
    expect(liveChatMenuCtx("plain")).toMatchObject({ autoAcceptOn: false, subchatsOn: false });
  });

  it("marks an external or automated chat read-only, a sub as a sub and a peer's chat as mirrored", () => {
    state.sessions = [
      sess("ext", { kind: "external" }),
      sess("auto-run", { kind: "automated" }),
      sess("sub", { subchat_of: "main" }),
      sess("far", { machine: { id: "m", label: "Laptop" } }),
    ];
    expect(liveChatMenuCtx("ext").readOnly).toBe(true);
    expect(liveChatMenuCtx("auto-run").readOnly).toBe(true);
    expect(liveChatMenuCtx("sub").isSub).toBe(true);
    expect(liveChatMenuCtx("far").mirrored).toBe(true);
  });

  it("reads the hidden flag from the saved hidden list", () => {
    state.sessions = [sess("a")];
    localStorage.setItem("cc_hidden_sessions", JSON.stringify(["a"]));
    expect(liveChatMenuCtx("a").isHidden).toBe(true);
    expect(liveChatMenuCtx("b").isHidden).toBe(false);
  });

  it("falls back to empty fields for a session the list does not hold", () => {
    const ctx = liveChatMenuCtx("gone");
    expect(ctx).toMatchObject({ cwd: null, pid: null, readOnly: false, isSub: false, isPinned: false, mirrored: false });
  });

  it("passes the after-action callback and the diff opener through, and warms the deploy cache off the phone only", () => {
    const viewChanges = vi.fn();
    const after = vi.fn();
    state.activeChatActions = { viewChanges };
    state.sessions = [sess("a")];
    const ctx = liveChatMenuCtx("a", after);
    expect(ctx.onAfterAction).toBe(after);
    expect(ctx.viewChanges).toBe(viewChanges);
    expect(refreshDeployWorkflowCache).toHaveBeenCalledWith("/repo");

    refreshDeployWorkflowCache.mockClear();
    remote = true;
    liveChatMenuCtx("a");
    expect(refreshDeployWorkflowCache).not.toHaveBeenCalled();
  });
});
