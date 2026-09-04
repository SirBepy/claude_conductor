// @vitest-environment jsdom

// The merged git chip replaces branch + repo + commits with one chip that prints
// only what cannot already be assumed. Every case below is a thing the chip is
// meant to STAY SILENT about, plus the one signal it can never drop.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { gitInfoCache } = await import("../src/views/sessions/session-statusbar-helpers.ts");

const SPAWN = "C:\\Projects\\zng-app";
const flush = () => new Promise((r) => setTimeout(r, 0));

function info(over = {}) {
  return { branch: "master", repo: "zng-app", ahead: 0, behind: 0, sha: "abc1234", insertions: null, deletions: null, ...over };
}

function mount(gitInfo, liveCwd = SPAWN) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  ipcMock.impl = async (cmd) => {
    if (cmd === "session_live_cwd") return liveCwd;
    if (cmd === "get_git_info") return gitInfo;
    return null;
  };
  const sb = new SessionStatusbar(el, null, [["git"]], { sessionId: "sess-git", cwd: SPAWN });
  return { el, sb };
}

function chip() { return document.querySelector(".sb-git"); }
function segs() { return Array.from(document.querySelectorAll(".sb-git-seg"), (s) => s.textContent.trim()); }

beforeEach(() => {
  document.body.innerHTML = "";
  gitInfoCache.clear();
  ipcMock.impl = async () => null;
});

describe("merged git chip", () => {
  it("in its own repo and level with upstream, prints the branch and nothing else", async () => {
    const { sb } = mount(info());
    await flush();
    expect(segs()).toEqual(["master"]);
    expect(chip().querySelector(".sb-git-away")).toBeNull();
    sb.destroy();
  });

  it("prints ahead and behind only when they are non-zero", async () => {
    const { sb } = mount(info({ ahead: 2, behind: 4 }));
    await flush();
    expect(segs()).toEqual(["master", "\u21912", "\u21934"]);
    sb.destroy();
  });

  it("drops the ahead segment alone when only behind is non-zero", async () => {
    const { sb } = mount(info({ ahead: 0, behind: 4 }));
    await flush();
    expect(segs()).toEqual(["master", "\u21934"]);
    sb.destroy();
  });

  it("marks a branch with no upstream instead of reading as level with one", async () => {
    const { sb } = mount(info({ ahead: null, behind: null }));
    await flush();
    expect(chip().querySelector(".sb-git-noup")).not.toBeNull();
    expect(chip().querySelector(".sb-git-ahead")).toBeNull();
    sb.destroy();
  });

  it("names the repo only once the AI has left the chat's own one", async () => {
    const { sb } = mount(info({ repo: "zng-api", branch: "develop", behind: 4 }), "C:\\Projects\\zng-api");
    await flush();
    expect(segs()).toEqual(["zng-api", "develop", "\u21934"]);
    sb.destroy();
  });

  it("stays silent about the repo for a subdirectory of the chat's own repo", async () => {
    const { sb } = mount(info(), "C:\\Projects\\zng-app\\packages\\api");
    await flush();
    expect(segs()).toEqual(["master"]);
    sb.destroy();
  });

  it("shows a skeleton until git info lands, then nothing if there is no branch", async () => {
    const { el, sb } = mount(info({ branch: null }));
    expect(el.querySelector('[data-skeleton="git"]')).not.toBeNull();
    await flush();
    expect(el.querySelector(".sb-git")).toBeNull();
    sb.destroy();
  });

  // A transport that silently degrades an unwired command answers null here.
  it("survives a null git-info response instead of taking the bar down", async () => {
    const { el, sb } = mount(null);
    await flush();
    expect(el.querySelector('[data-skeleton="git"]')).toBeNull();
    expect(el.querySelector(".sb-git")).toBeNull();
    sb.destroy();
  });
});
