// @vitest-environment jsdom

// The merged git card: one shell for what used to be the branch popover and the
// commits popover. Covers the history list (marked rows, paging, push reload,
// stale-page drops) plus the two things the merge added - the branch mode behind
// the branch line, and the drift footer naming where the AI actually is.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { GitCard } = await import("../src/views/sessions/git-card.ts");

const CWD = "C:\\repo";
const flush = () => new Promise((r) => setTimeout(r, 0));

const INFO = { branch: "master", repo: "repo", ahead: 1, behind: 0, sha: "abc1234", insertions: null, deletions: null };
const SYNC_AHEAD = { ahead: [{ short_sha: "sha0", message: "commit 0" }], behind: [], has_upstream: true };

function entries(from, count, pushed) {
  return Array.from({ length: count }, (_, i) => ({
    short_sha: `sha${from + i}`,
    message: `commit ${from + i}`,
    pushed,
    timestamp: 1_700_000_000 - (from + i) * 3600,
  }));
}

function anchor() {
  const a = document.createElement("span");
  document.body.appendChild(a);
  return a;
}

function pop() { return document.querySelector(".sb-git-card"); }
function rows() { return Array.from(document.querySelectorAll(".sb-history-row")); }

/** Answers the card's own head fetch; `extra` overrides or adds commands. */
function ipc(extra) {
  return async (cmd, args) => {
    if (cmd === "get_git_info") return INFO;
    if (cmd === "get_commit_sync") return SYNC_AHEAD;
    return extra ? extra(cmd, args) : null;
  };
}

function open(card, over = {}) {
  card.open(anchor(), { cwd: CWD, awayLabel: null, onPushed: () => {}, ...over });
}

beforeEach(() => {
  document.body.innerHTML = "";
  ipcMock.impl = async () => null;
  vi.restoreAllMocks();
});

describe("git card history", () => {
  it("renders pushed and unpushed rows in one list, each marked", async () => {
    ipcMock.impl = ipc((cmd) =>
      cmd === "get_commit_history"
        ? { entries: [...entries(0, 1, false), ...entries(1, 2, true)], has_more: false, has_upstream: true }
        : null);
    const p = new GitCard();
    open(p);
    await flush();

    const all = rows();
    expect(all.length).toBe(3);
    expect(all[0].classList.contains("unpushed")).toBe(true);
    expect(all[0].querySelector(".ph-arrow-up")).toBeTruthy();
    expect(all[1].classList.contains("pushed")).toBe(true);
    expect(all[1].querySelector(".ph-check")).toBeTruthy();
    expect(pop().querySelector(".sb-git-pop-push-btn")).toBeTruthy();
    p.close();
  });

  it("pages the next batch in on scroll, appending rather than replacing", async () => {
    const calls = [];
    ipcMock.impl = ipc((cmd, args) => {
      if (cmd !== "get_commit_history") return null;
      calls.push(args.offset);
      return { entries: entries(args.offset, 30, args.offset > 0), has_more: args.offset < 30, has_upstream: true };
    });
    const p = new GitCard();
    open(p);
    await flush();
    expect(rows().length).toBe(30);

    const list = pop().querySelector(".sb-commit-history");
    list.dispatchEvent(new Event("scroll"));
    await flush();

    expect(calls).toEqual([0, 30]);
    expect(rows().length).toBe(60);
    expect(rows()[0].textContent).toContain("commit 0");
    expect(rows()[59].textContent).toContain("commit 59");
    p.close();
  });

  it("stops paging once has_more is false", async () => {
    const calls = [];
    ipcMock.impl = ipc((cmd, args) => {
      if (cmd !== "get_commit_history") return null;
      calls.push(args.offset);
      return { entries: entries(args.offset, 2, true), has_more: false, has_upstream: true };
    });
    const p = new GitCard();
    open(p);
    await flush();
    const list = pop().querySelector(".sb-commit-history");
    list.dispatchEvent(new Event("scroll"));
    list.dispatchEvent(new Event("scroll"));
    await flush();
    expect(calls).toEqual([0]);
    expect(pop().querySelector(".sb-history-sentinel.end")).toBeTruthy();
    p.close();
  });

  it("reloads the history after a push so nothing still reads as unpushed", async () => {
    let historyCalls = 0;
    let pushed = false;
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_git_info") return INFO;
      if (cmd === "get_commit_sync") return pushed ? { ahead: [], behind: [], has_upstream: true } : SYNC_AHEAD;
      if (cmd === "push_commits") { pushed = true; return null; }
      if (cmd === "get_commit_history") {
        historyCalls += 1;
        return { entries: entries(0, 2, historyCalls > 1), has_more: false, has_upstream: true };
      }
      return null;
    };
    const p = new GitCard();
    open(p);
    await flush();
    expect(rows().every((r) => r.classList.contains("unpushed"))).toBe(true);

    pop().querySelector(".sb-git-pop-push-btn").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    await flush();

    expect(historyCalls).toBe(2);
    expect(rows().length).toBe(2);
    expect(rows().every((r) => r.classList.contains("pushed"))).toBe(true);
    p.close();
  });

  it("keeps the publish path and still lists commits with no upstream", async () => {
    const noUpstream = { ahead: [], behind: [], has_upstream: false };
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_git_info") return { ...INFO, branch: "feature", ahead: null, behind: null };
      if (cmd === "get_commit_sync") return noUpstream;
      if (cmd === "get_commit_history") return { entries: entries(0, 2, false), has_more: false, has_upstream: false };
      return null;
    };
    const p = new GitCard();
    open(p);
    await flush();
    expect(pop().querySelector(".sb-git-pop-publish-btn")).toBeTruthy();
    expect(rows().length).toBe(2);
    expect(rows().every((r) => r.classList.contains("unpushed"))).toBe(true);
    p.close();
  });

  it("drops a page that lands after the card moved to another repo", async () => {
    let resolveFirst;
    ipcMock.impl = ipc((cmd) =>
      cmd === "get_commit_history" ? new Promise((res) => { resolveFirst = res; }) : null);
    const p = new GitCard();
    open(p);
    p.close();
    resolveFirst({ entries: entries(0, 3, true), has_more: false, has_upstream: true });
    await flush();
    expect(pop()).toBeNull();
  });

  it("drops a stale page after close+reopen on the same repo, no duplicate rows", async () => {
    const resolvers = [];
    ipcMock.impl = ipc((cmd) =>
      cmd === "get_commit_history" ? new Promise((res) => resolvers.push(res)) : null);
    const p = new GitCard();
    open(p);
    p.close();
    open(p);
    resolvers[0]({ entries: entries(0, 2, true), has_more: false, has_upstream: true });
    resolvers[1]({ entries: entries(0, 2, true), has_more: false, has_upstream: true });
    await flush();
    await flush();

    expect(rows().length).toBe(2);
    expect(rows()[0].textContent).toContain("commit 0");
    expect(rows()[1].textContent).toContain("commit 1");
    p.close();
  });

  it("shows Incoming, not the synced pill, when behind with nothing ahead", async () => {
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_git_info") return { ...INFO, ahead: 0, behind: 1 };
      if (cmd === "get_commit_sync") return { ahead: [], behind: [{ short_sha: "sha9", message: "commit 9" }], has_upstream: true };
      if (cmd === "get_commit_history") return { entries: entries(0, 1, true), has_more: false, has_upstream: true };
      return null;
    };
    const p = new GitCard();
    open(p);
    await flush();
    expect(pop().textContent).not.toContain("Up to date with upstream");
    expect(pop().querySelector(".sb-git-pop-section.behind")).toBeTruthy();
    p.close();
  });
});

describe("git card branch mode", () => {
  const BRANCHES = [
    { name: "master", current: true, short_sha: "aaa1111", upstream: "origin/master" },
    { name: "feat/claim-state", current: false, short_sha: "bbb2222", upstream: null },
    { name: "fix/claim-retry", current: false, short_sha: "ccc3333", upstream: null },
  ];

  function branchIpc() {
    return ipc((cmd) => {
      if (cmd === "get_recent_branches") return BRANCHES;
      if (cmd === "get_commit_history") return { entries: entries(0, 1, true), has_more: false, has_upstream: true };
      return null;
    });
  }

  it("prints the current branch's upstream on the branch line", async () => {
    ipcMock.impl = branchIpc();
    const p = new GitCard();
    open(p);
    await flush();
    expect(pop().querySelector(".gc-branchline .up").textContent).toBe("origin/master");
    p.close();
  });

  it("the branch line opens the branch list, and back returns to the history", async () => {
    ipcMock.impl = branchIpc();
    const p = new GitCard();
    open(p);
    await flush();
    expect(pop().querySelector(".gc-branchline .bname").textContent).toBe("master");

    pop().querySelector(".gc-branchline").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelectorAll(".sb-git-pop-row").length).toBe(3);
    expect(rows().length).toBe(0);

    pop().querySelector(".gc-back").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(rows().length).toBe(1);
    p.close();
  });

  it("filters the branch list without rebuilding the search box", async () => {
    ipcMock.impl = branchIpc();
    const p = new GitCard();
    open(p);
    await flush();
    pop().querySelector(".gc-branchline").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const input = pop().querySelector(".gc-search input");
    input.value = "claim";
    input.dispatchEvent(new Event("input"));

    const names = Array.from(document.querySelectorAll(".sb-git-pop-name"), (n) => n.textContent);
    expect(names).toEqual(["feat/claim-state", "fix/claim-retry"]);
    // Same node, so the caret position survived the filter.
    expect(pop().querySelector(".gc-search input")).toBe(input);
    p.close();
  });
});

describe("git card drift footer", () => {
  it("names the repo the AI moved into, and only then", async () => {
    ipcMock.impl = ipc((cmd) =>
      cmd === "get_commit_history" ? { entries: entries(0, 1, true), has_more: false, has_upstream: true } : null);

    const home = new GitCard();
    open(home);
    await flush();
    expect(pop().querySelector(".gc-away-foot")).toBeNull();
    home.close();

    const away = new GitCard();
    open(away, { awayLabel: "other-repo" });
    await flush();
    const foot = pop().querySelector(".gc-away-foot");
    expect(foot).not.toBeNull();
    expect(foot.textContent).toContain("Claude is in other-repo");
    // The card body stays about the chat's own repo regardless.
    expect(pop().querySelector(".sb-git-pop-header").textContent).toContain("repo");
    away.close();
  });
});
