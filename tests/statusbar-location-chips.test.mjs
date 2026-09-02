// @vitest-environment jsdom

// repo + folder chips are location chips: silent while the chat is still in the
// folder it was opened in, visible the moment the AI moves out (worktree,
// sibling repo, parent dir).

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { isAtSpawnLocation } = await import("../src/views/sessions/statusbar-chips.ts");
const { gitInfoCache } = await import("../src/views/sessions/session-statusbar-helpers.ts");

const SPAWN = "C:\\Users\\joe\\Projects\\claude_usage_in_taskbar";
const GIT_INFO = {
  branch: "master", repo: "claude_conductor", ahead: 6, behind: 0,
  sha: "abc1234", insertions: 0, deletions: 0,
};

function mount(liveCwd) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  ipcMock.impl = async (cmd) => {
    if (cmd === "session_live_cwd") return liveCwd;
    if (cmd === "get_git_info") return GIT_INFO;
    if (cmd === "get_git_dirty") return [];
    return null;
  };
  const sb = new SessionStatusbar(el, null, [["repo", "folder", "branch"]], {
    sessionId: "sess-loc",
    cwd: SPAWN,
  });
  return { el, sb };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = "";
  gitInfoCache.clear();
  ipcMock.impl = async () => null;
  vi.restoreAllMocks();
});

describe("isAtSpawnLocation", () => {
  it("matches the same dir across separator + case differences", () => {
    expect(isAtSpawnLocation("C:\\a\\b", "c:/A/B")).toBe(true);
    expect(isAtSpawnLocation("C:\\a\\b\\", "C:\\a\\b")).toBe(true);
  });
  it("matches a subdirectory of the spawn dir", () => {
    expect(isAtSpawnLocation("C:\\a\\b", "C:\\a\\b\\src\\views")).toBe(true);
  });
  it("does not match a sibling that merely shares a prefix", () => {
    expect(isAtSpawnLocation("C:\\a\\b", "C:\\a\\b-2")).toBe(false);
  });
  it("does not match a parent, a sibling worktree, or a null side", () => {
    expect(isAtSpawnLocation("C:\\a\\b", "C:\\a")).toBe(false);
    expect(isAtSpawnLocation("C:\\a\\b", "C:\\a\\wt-feature")).toBe(false);
    expect(isAtSpawnLocation(null, "C:\\a")).toBe(false);
    expect(isAtSpawnLocation("C:\\a", null)).toBe(false);
  });
});

describe("repo + folder chips", () => {
  it("stay hidden while the session sits in its spawn dir", async () => {
    const { el } = mount(SPAWN);
    await flush();
    expect(el.querySelector(".sb-folder")).toBeNull();
    expect(el.querySelector(".sb-repo")).toBeNull();
    // A sibling git chip still renders, so this isn't just "git never loaded".
    expect(el.querySelector(".sb-branch")?.textContent).toContain("master");
  });

  it("stay hidden in a subdirectory of the spawn dir", async () => {
    const { el } = mount(`${SPAWN}\\src\\views`);
    await flush();
    expect(el.querySelector(".sb-folder")).toBeNull();
    expect(el.querySelector(".sb-repo")).toBeNull();
  });

  it("both appear once the AI moves into a worktree", async () => {
    const { el } = mount("C:\\Users\\joe\\Projects\\wt-feature");
    await flush();
    expect(el.querySelector(".sb-folder")?.textContent).toContain("wt-feature");
    expect(el.querySelector(".sb-repo")?.textContent).toContain("claude_conductor");
  });

  it("no skeleton flashes for either chip before git info lands", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    ipcMock.impl = async (cmd) => (cmd === "session_live_cwd" ? SPAWN : null);
    new SessionStatusbar(el, null, [["repo", "folder"]], { sessionId: "sess-skel", cwd: SPAWN });
    expect(el.querySelector('[data-skeleton="repo"]')).toBeNull();
    expect(el.querySelector('[data-skeleton="folder"]')).toBeNull();
  });
});
