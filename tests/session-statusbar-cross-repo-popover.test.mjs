// @vitest-environment jsdom
// Regression: switching sessions mid-flight let a stale get_commit_sync response
// open a popover on a detached anchor (Bug A), and let a late get_git_info write
// land under the NEW gitCwd after a worktree move (Bug B, poisons gitInfoCache).

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

// Everything below is peripheral to the two guards under test; stubbed so
// the real pending-pane.ts + session-statusbar.ts + state.ts drive the assert.
vi.mock("../src/shared/api.ts", () => ({ api: { setSessionCharacter: vi.fn(async () => {}) } }));
vi.mock("../src/shared/chat/chat-renderer.ts", () => ({
  ChatRenderer: vi.fn().mockImplementation(() => ({
    detach: vi.fn(),
    attach: vi.fn(async () => {}),
    currentSessionId: vi.fn(() => null),
    swapSubscription: vi.fn(async () => {}),
    toolTally: { byType: [] },
    getFileEdits: vi.fn(() => []),
  })),
}));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: {
    subscribe: vi.fn(() => () => {}),
    pushSynthetic: vi.fn(),
    hasMore: vi.fn(() => false),
  },
}));
vi.mock("../src/shared/chat/pr-review-modal.ts", () => ({ setPrReviewCwdProvider: vi.fn() }));
vi.mock("../src/shared/chat/composer.ts", () => ({
  Composer: vi.fn().mockImplementation(() => ({
    destroy: vi.fn(),
    setSessionId: vi.fn(),
    getDraftBlocks: vi.fn(() => []),
    isDraftEmpty: vi.fn(() => true),
    isComposing: vi.fn(() => false),
    clearComposer: vi.fn(),
  })),
}));
vi.mock("../src/shared/chat/held-messages.ts", () => ({
  HeldMessages: vi.fn().mockImplementation(() => ({ attach: vi.fn() })),
}));
vi.mock("../src/shared/chat/schedule-picker.ts", () => ({ formatFireAt: vi.fn((x) => String(x)) }));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({
  isCurrentSessionBusy: vi.fn(() => false),
  updateThinkingBar: vi.fn(),
  syncThinkingBar: vi.fn(),
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  projectName: vi.fn(() => ""),
  sessionSubtitle: vi.fn(() => ""),
}));
vi.mock("../src/views/sessions/sidebar.ts", () => ({
  renderSidebar: vi.fn(),
  refreshSessions: vi.fn(async () => {}),
}));
vi.mock("../src/views/sessions/session-characters.ts", () => ({
  characterForSession: vi.fn(() => null),
  characterIconUrl: vi.fn(() => ""),
}));
vi.mock("../src/shared/projects.ts", () => ({
  hydrateCharacterAvatars: vi.fn(async () => {}),
  hydrateProjectTechIcons: vi.fn(async () => {}),
}));
vi.mock("../src/views/sessions/permission-modal/index.ts", () => ({
  isAutoAccept: vi.fn(() => false),
  setAutoAccept: vi.fn(),
  setSelectedSessionId: vi.fn(),
}));
vi.mock("../src/views/sessions/changes-panel.ts", () => ({
  ChangesPanel: vi.fn(),
  dedupeByPath: vi.fn(() => []),
}));
vi.mock("../src/views/sessions/active-session-mount.ts", () => ({ wireRenderer: vi.fn() }));
vi.mock("../src/views/sessions/chat-pane-cache.ts", () => ({ retainChat: vi.fn() }));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { gitInfoCache } = await import("../src/views/sessions/session-statusbar-helpers.ts");
const { renderPendingPane } = await import("../src/views/sessions/pending-pane.ts");
const { state } = await import("../src/views/sessions/state.ts");

const CWD_A = "C:/zng-app";
const CWD_B = "C:/.claude";

function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

beforeEach(() => {
  document.body.innerHTML = "";
  gitInfoCache.clear();
  ipcMock.impl = async () => null;
});

describe("commits popover: stale invoke after session switch (Bug A)", () => {
  it("does not open a popover for a resolved-late fetch once the chip's anchor has detached", async () => {
    gitInfoCache.set(CWD_A, {
      branch: "main", repo: "zng-app", ahead: 2, behind: 0, sha: "abc1234", insertions: null, deletions: null,
    });

    const el = document.createElement("div");
    document.body.appendChild(el);
    // No sessionId -> resolveGitCwd skips the session_live_cwd round trip and
    // keeps gitCwd pinned at the spawn cwd, isolating this from Bug B's path.
    const sb = new SessionStatusbar(el, null, [["commits"]], { cwd: CWD_A, hideZero: true });

    let resolveSync;
    const commitSyncPromise = new Promise((resolve) => { resolveSync = resolve; });
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_commit_sync") return commitSyncPromise;
      return null;
    };

    const anchor = el.querySelector(".sb-commits-btn");
    expect(anchor).not.toBeNull();
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    // Mirrors active-session.ts:323 rewriting the pane's innerHTML on a
    // session switch mid-flight - the anchor detaches from the document
    // while this instance's own gitCwd never moves.
    el.innerHTML = "";

    resolveSync({
      ahead: Array.from({ length: 50 }, (_, i) => ({ short_sha: `zz${i}`, message: `.claude commit ${i}` })),
      behind: [],
      has_upstream: true,
    });
    await flush();

    expect(document.body.querySelector(".sb-popover")).toBeNull();
  });
});

describe("pending-pane git-info fetch: cwd identity (Bug B)", () => {
  it("does not let a late fetch for the OLD cwd overwrite the cache entry for the NEW (moved-to) cwd", async () => {
    const infoA = { branch: "main", repo: "zng-app", ahead: 2, behind: 0, sha: "aaa1111", insertions: null, deletions: null };
    const infoB = { branch: "wt", repo: "claude-conductor", ahead: 1, behind: 0, sha: "bbb2222", insertions: null, deletions: null };

    let resolveInfoA;
    const infoAPromise = new Promise((resolve) => { resolveInfoA = resolve; });
    ipcMock.impl = async (cmd, args) => {
      if (cmd === "get_settings") return {};
      if (cmd === "session_live_cwd") return CWD_B; // AI followed into a worktree
      if (cmd === "get_git_info") return args.cwd === CWD_B ? infoB : infoAPromise;
      return null;
    };

    const pane = document.createElement("div");
    document.body.appendChild(pane);
    await renderPendingPane(pane, "pending-1", { path: CWD_A, name: "zng-app" }, { model: "opus", effort: "high" });
    await flush();
    await flush();

    // By now the statusbar's own resolveGitCwd() (triggered by the
    // git-section chips in DEFAULT_ROWS) has moved gitCwd to CWD_B and
    // cached CWD_B's own info. pending-pane's separate fetchGitInfo(CWD_A)
    // call is still in flight.
    expect(gitInfoCache.get(CWD_B)).toEqual(infoB);

    // The CWD_A fetch resolves late. Unguarded, updateGitInfo writes it under
    // `this.gitCwd` (now CWD_B), poisoning CWD_B's entry with repo-A data.
    resolveInfoA(infoA);
    await flush();

    expect(gitInfoCache.get(CWD_B)).not.toEqual(infoA);
    expect(gitInfoCache.get(CWD_B)).toEqual(infoB);
    state.statusbar = null;
  });
});
