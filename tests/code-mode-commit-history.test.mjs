// @vitest-environment jsdom

// Code mode's "Show older commits" row: the branch's already-pushed history,
// paged in below the unpushed commits via get_commit_history. Pure markup
// first, then the row driven through a real CodeModeInstance.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ipcMock = { impl: async () => null };
const calls = [];
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => {
    calls.push([cmd, args]);
    return ipcMock.impl(cmd, args);
  }),
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false, isTauri: () => true }));
vi.mock("../src/shared/back-button.ts", () => ({ registerOverlayBack: () => () => {} }));

const { explorerHtml } = await import("../src/views/sessions/code-mode/explorer-html.ts");
const { openCodeMode, closeCodeMode } = await import("../src/views/sessions/code-mode/code-mode.ts");

Element.prototype.scrollIntoView = function () {};

const CWD = "C:\\repo";
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

function model(over = {}) {
  return {
    scope: { kind: "unpushed" },
    data: { changed: new Map(), paths: [], error: null },
    collapsed: new Set(),
    activePath: null,
    menuOpen: false,
    menuCounts: {},
    git: null,
    commitsOpen: false,
    branchOpen: false,
    gitBusy: null,
    gitError: null,
    ...over,
  };
}

function render(m) {
  const el = document.createElement("div");
  el.innerHTML = explorerHtml(m);
  return el;
}

const git = (sync, branch = "master", upstream = "origin/master") => ({ sync, branch, upstream });
const SYNC = { ahead: [{ short_sha: "abc1234", message: "FEAT: one" }], behind: [], has_upstream: true };

describe("explorer markup: Show older commits row", () => {
  it("renders at the end of the fold, below Push, when there is an upstream", () => {
    const el = render(model({ commitsOpen: true, git: git({ ahead: [], behind: [], has_upstream: true }) }));
    const last = el.querySelector(".cm-commits > .cm-commit:last-child");
    expect(last.classList.contains("cm-older-trigger")).toBe(true);
    expect(last.textContent).toContain("Show older commits");
    expect(last.dataset.act).toBe("older-commits");
  });

  it("is absent with no upstream - get_commit_history would flag nothing as pushed", () => {
    const el = render(model({ commitsOpen: true, git: git({ ahead: [], behind: [], has_upstream: false }, "feat/x", null) }));
    expect(el.querySelector(".cm-older-trigger")).toBeNull();
  });

  it("is absent once exhausted (olderDone), even with rows already loaded", () => {
    const el = render(model({
      commitsOpen: true,
      git: git({ ahead: [], behind: [], has_upstream: true }),
      older: [{ short_sha: "ddd", message: "old one", pushed: true, timestamp: 0 }],
      olderDone: true,
    }));
    expect(el.querySelector(".cm-older-trigger")).toBeNull();
    expect(el.querySelector('[data-commit="ddd"]')).not.toBeNull();
  });

  it("muted older rows render below Push, reusing the commit-row markup and the data-commit click target", () => {
    const el = render(model({
      commitsOpen: true,
      git: git({ ahead: [{ short_sha: "aaa", message: "unpushed one" }], behind: [], has_upstream: true }),
      older: [{ short_sha: "ddd", message: "old one", pushed: true, timestamp: 0 }],
    }));
    const rows = Array.from(el.querySelectorAll(".cm-commits > .cm-commit"));
    const pushIdx = rows.findIndex((r) => r.classList.contains("cm-pushrow"));
    const olderIdx = rows.findIndex((r) => r.dataset.commit === "ddd");
    const triggerIdx = rows.findIndex((r) => r.classList.contains("cm-older-trigger"));
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThan(pushIdx);
    expect(triggerIdx).toBe(rows.length - 1);
    expect(rows[olderIdx].classList.contains("cm-older")).toBe(true);
    expect(rows[olderIdx].dataset.title).toBe("old one");
  });
});

describe("Code mode: loading older commits", () => {
  let layout;

  function chat(over = {}) {
    return {
      key: "hist1",
      sessionId: "hist1",
      cwd: CWD,
      layout,
      title: () => "My chat",
      busy: () => false,
      latestLine: () => "",
      edits: () => [],
      mention: null,
      onGitChanged: vi.fn(),
      ...over,
    };
  }

  beforeEach(() => {
    calls.length = 0;
    document.body.innerHTML = `<div class="sessions-layout"><aside class="sessions-sidebar"></aside><main id="session-pane"></main></div>`;
    layout = document.querySelector(".sessions-layout");
    ipcMock.impl = async (cmd, args) => {
      if (cmd === "get_commit_sync") return SYNC;
      if (cmd === "get_git_info") return { branch: "master" };
      if (cmd === "get_recent_branches") return [{ name: "master", current: true, short_sha: "abc1234", upstream: "origin/master" }];
      if (cmd === "get_git_dirty") return [];
      if (cmd === "get_range_files") return args.to === "old0001"
        ? [{ path: "src/legacy.ts", status: "M", added: 1, removed: 0, old_path: null }]
        : [];
      if (cmd === "get_file_at_rev") return { content: "x", truncated: false };
      return null;
    };
  });

  afterEach(() => {
    closeCodeMode();
  });

  const root = () => document.querySelector(".code-mode");

  it("clicking Show older commits requests page 0 and appends muted rows below Push", async () => {
    ipcMock.impl = async (cmd, args) => {
      if (cmd === "get_commit_sync") return SYNC;
      if (cmd === "get_git_info") return { branch: "master" };
      if (cmd === "get_recent_branches") return [{ name: "master", current: true, short_sha: "abc1234", upstream: "origin/master" }];
      if (cmd === "get_git_dirty") return [];
      if (cmd === "get_range_files") return [];
      if (cmd === "get_commit_history") {
        expect(args).toEqual({ cwd: CWD, offset: 0, limit: 30 });
        return { entries: [{ short_sha: "old0001", message: "FIX: ancient bug", pushed: true, timestamp: 1 }], has_more: true, has_upstream: true };
      }
      return null;
    };
    openCodeMode(chat(), { kind: "scope", scope: "unpushed", commitsOpen: true });
    await settle();
    expect(root().querySelector(".cm-older-trigger")).not.toBeNull();
    root().querySelector('[data-act="older-commits"]').click();
    await settle();
    expect(calls).toContainEqual(["get_commit_history", { cwd: CWD, offset: 0, limit: 30 }]);
    const row = root().querySelector('[data-commit="old0001"]');
    expect(row).not.toBeNull();
    expect(row.classList.contains("cm-older")).toBe(true);
    // Still unpushed above it, still a Push button, trigger stays last for the next page.
    expect(root().querySelector('[data-commit="abc1234"]')).not.toBeNull();
    expect(root().querySelector('[data-act="older-commits"]')).not.toBeNull();
  });

  it("a commit already shown as unpushed is not repeated in the older section", async () => {
    ipcMock.impl = async (cmd, args) => {
      if (cmd === "get_commit_sync") return SYNC;
      if (cmd === "get_git_info") return { branch: "master" };
      if (cmd === "get_recent_branches") return [{ name: "master", current: true, short_sha: "abc1234", upstream: "origin/master" }];
      if (cmd === "get_git_dirty") return [];
      if (cmd === "get_range_files") return [];
      if (cmd === "get_commit_history") {
        // The raw log interleaves the still-unpushed commit with older pushed ones.
        return {
          entries: [
            { short_sha: "abc1234", message: "FEAT: one", pushed: false, timestamp: 2 },
            { short_sha: "old0001", message: "FIX: ancient bug", pushed: true, timestamp: 1 },
          ],
          has_more: false,
          has_upstream: true,
        };
      }
      return null;
    };
    openCodeMode(chat({ key: "hist2" }), { kind: "scope", scope: "unpushed", commitsOpen: true });
    await settle();
    root().querySelector('[data-act="older-commits"]').click();
    await settle();
    expect(root().querySelectorAll('[data-commit="abc1234"]')).toHaveLength(1);
    expect(root().querySelector('[data-commit="old0001"]')).not.toBeNull();
  });

  it("the row disappears once a page comes back exhausted (has_more: false)", async () => {
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_commit_sync") return SYNC;
      if (cmd === "get_git_info") return { branch: "master" };
      if (cmd === "get_recent_branches") return [{ name: "master", current: true, short_sha: "abc1234", upstream: "origin/master" }];
      if (cmd === "get_git_dirty") return [];
      if (cmd === "get_range_files") return [];
      if (cmd === "get_commit_history") {
        return { entries: [{ short_sha: "old0001", message: "FIX: ancient bug", pushed: true, timestamp: 1 }], has_more: false, has_upstream: true };
      }
      return null;
    };
    openCodeMode(chat({ key: "hist3" }), { kind: "scope", scope: "unpushed", commitsOpen: true });
    await settle();
    root().querySelector('[data-act="older-commits"]').click();
    await settle();
    expect(root().querySelector('[data-commit="old0001"]')).not.toBeNull();
    expect(root().querySelector('[data-act="older-commits"]')).toBeNull();
  });

  it("clicking an older row opens that commit the same way an unpushed row does", async () => {
    ipcMock.impl = async (cmd, args) => {
      if (cmd === "get_commit_sync") return SYNC;
      if (cmd === "get_git_info") return { branch: "master" };
      if (cmd === "get_recent_branches") return [{ name: "master", current: true, short_sha: "abc1234", upstream: "origin/master" }];
      if (cmd === "get_git_dirty") return [];
      if (cmd === "get_commit_history") {
        return { entries: [{ short_sha: "old0001", message: "FIX: ancient bug", pushed: true, timestamp: 1 }], has_more: false, has_upstream: true };
      }
      if (cmd === "get_range_files") return args.to === "old0001"
        ? [{ path: "src/legacy.ts", status: "M", added: 1, removed: 0, old_path: null }]
        : [];
      if (cmd === "get_file_at_rev") return { content: "x", truncated: false };
      return null;
    };
    openCodeMode(chat({ key: "hist4" }), { kind: "scope", scope: "unpushed", commitsOpen: true });
    await settle();
    root().querySelector('[data-act="older-commits"]').click();
    await settle();
    root().querySelector('[data-commit="old0001"]').click();
    await settle();
    expect(root().querySelector(".cm-ctitle").textContent).toBe("FIX: ancient bug");
    expect(calls).toContainEqual(["get_range_files", { cwd: CWD, from: null, to: "old0001" }]);
    expect(root().querySelector(".cm-tab.on").dataset.tab).toBe("src/legacy.ts");
  });

  it("a push resets older-commits state (the log just changed)", async () => {
    let historyCalls = 0;
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_commit_sync") return SYNC;
      if (cmd === "get_git_info") return { branch: "master" };
      if (cmd === "get_recent_branches") return [{ name: "master", current: true, short_sha: "abc1234", upstream: "origin/master" }];
      if (cmd === "get_git_dirty") return [];
      if (cmd === "get_range_files") return [];
      if (cmd === "push_commits") return null;
      if (cmd === "get_commit_history") {
        historyCalls++;
        return { entries: [{ short_sha: `old000${historyCalls}`, message: "FIX: ancient bug", pushed: true, timestamp: 1 }], has_more: false, has_upstream: true };
      }
      return null;
    };
    const c = chat({ key: "hist5" });
    openCodeMode(c, { kind: "scope", scope: "unpushed", commitsOpen: true });
    await settle();
    root().querySelector('[data-act="older-commits"]').click();
    await settle();
    expect(root().querySelector('[data-commit="old0001"]')).not.toBeNull();
    root().querySelector('[data-act="push"]').click();
    await settle();
    expect(c.onGitChanged).toHaveBeenCalled();
    // The push reload cleared the exhausted state - the trigger offers another page.
    expect(root().querySelector('[data-act="older-commits"]')).not.toBeNull();
  });
});
