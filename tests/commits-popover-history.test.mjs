// @vitest-environment jsdom

// Commits popover: one merged history list, unpushed rows marked, paged in on
// scroll without losing the rows already there.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { CommitsPopover } = await import("../src/views/sessions/commits-popover.ts");

const CWD = "C:\\repo";
const flush = () => new Promise((r) => setTimeout(r, 0));

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

function pop() { return document.querySelector(".sb-commits-popover"); }
function rows() { return Array.from(document.querySelectorAll(".sb-history-row")); }

const SYNC_AHEAD = { ahead: [{ short_sha: "sha0", message: "commit 0" }], behind: [], has_upstream: true };

beforeEach(() => {
  document.body.innerHTML = "";
  ipcMock.impl = async () => null;
  vi.restoreAllMocks();
});

describe("commits popover history", () => {
  it("renders pushed and unpushed rows in one list, each marked", async () => {
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_commit_history") {
        return { entries: [...entries(0, 1, false), ...entries(1, 2, true)], has_more: false, has_upstream: true };
      }
      return null;
    };
    const p = new CommitsPopover();
    p.open(anchor(), CWD, SYNC_AHEAD, "master", () => {});
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
    ipcMock.impl = async (cmd, args) => {
      if (cmd !== "get_commit_history") return null;
      calls.push(args.offset);
      return { entries: entries(args.offset, 30, args.offset > 0), has_more: args.offset < 30, has_upstream: true };
    };
    const p = new CommitsPopover();
    p.open(anchor(), CWD, SYNC_AHEAD, "master", () => {});
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
    ipcMock.impl = async (cmd, args) => {
      if (cmd !== "get_commit_history") return null;
      calls.push(args.offset);
      return { entries: entries(args.offset, 2, true), has_more: false, has_upstream: true };
    };
    const p = new CommitsPopover();
    p.open(anchor(), CWD, SYNC_AHEAD, "master", () => {});
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
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_commit_history") {
        historyCalls += 1;
        return { entries: entries(0, 2, historyCalls > 1), has_more: false, has_upstream: true };
      }
      if (cmd === "push_commits") return null;
      if (cmd === "get_commit_sync") return { ahead: [], behind: [], has_upstream: true };
      return null;
    };
    const p = new CommitsPopover();
    p.open(anchor(), CWD, SYNC_AHEAD, "master", () => {});
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
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_commit_history") return { entries: entries(0, 2, false), has_more: false, has_upstream: false };
      return null;
    };
    const p = new CommitsPopover();
    p.open(anchor(), CWD, { ahead: [], behind: [], has_upstream: false }, "feature", () => {});
    await flush();
    expect(pop().querySelector(".sb-git-pop-publish-btn")).toBeTruthy();
    expect(rows().length).toBe(2);
    expect(rows().every((r) => r.classList.contains("unpushed"))).toBe(true);
    p.close();
  });

  it("drops a page that lands after the popover moved to another repo", async () => {
    let resolveFirst;
    ipcMock.impl = async (cmd) => {
      if (cmd !== "get_commit_history") return null;
      return new Promise((res) => { resolveFirst = res; });
    };
    const p = new CommitsPopover();
    p.open(anchor(), CWD, SYNC_AHEAD, "master", () => {});
    p.close();
    resolveFirst({ entries: entries(0, 3, true), has_more: false, has_upstream: true });
    await flush();
    expect(pop()).toBeNull();
  });
});
