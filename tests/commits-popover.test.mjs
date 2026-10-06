// @vitest-environment jsdom

// The git chip's commit popover: a paged list of the branch's commits, pushed
// and unpushed marked. A row opens that commit in Code mode; a copy button
// copies without opening it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));
const openInCodeMode = vi.fn();
vi.mock("../src/shared/chat/code-mode-bridge.ts", () => ({ openInCodeMode: (t) => openInCodeMode(t) }));

const { CommitsPopover } = await import("../src/views/sessions/commits-popover.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const CWD = "C:\\repo";
const TS = 1700000000n;

function entries() {
  return [
    { short_sha: "a1b2c3d", message: "Add the popover", pushed: false, timestamp: TS },
    { short_sha: "e4f5a6b", message: "Old work", pushed: true, timestamp: TS - 86400n },
  ];
}

describe("CommitsPopover", () => {
  let anchor;
  beforeEach(() => {
    document.body.innerHTML = "";
    anchor = document.createElement("span");
    anchor.className = "sb-git-btn";
    document.body.appendChild(anchor);
    openInCodeMode.mockClear();
    ipcMock.impl = async () => ({ entries: entries(), has_more: false, has_upstream: true });
  });

  it("lists pushed and unpushed commits with copy buttons on each row", async () => {
    const pop = new CommitsPopover();
    pop.open(anchor, CWD);
    await settle();

    const rows = document.querySelectorAll(".cp-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].classList.contains("unpushed")).toBe(true);
    expect(rows[1].classList.contains("pushed")).toBe(true);
    const copies = [...rows[0].querySelectorAll(".cp-copy")].map((b) => b.dataset.copy);
    expect(copies).toEqual(["a1b2c3d", "Add the popover"]);
    expect(rows[0].querySelector(".cp-abs").textContent).not.toBe("");
    pop.close();
  });

  it("clicking a row opens that commit in Code mode and closes the popover", async () => {
    const pop = new CommitsPopover();
    pop.open(anchor, CWD);
    await settle();

    document.querySelector('.cp-row[data-sha="e4f5a6b"]').click();

    expect(openInCodeMode).toHaveBeenCalledWith({ kind: "commit", sha: "e4f5a6b", title: "Old work" });
    expect(pop.isOpen).toBe(false);
  });

  it("a copy button copies its text and does not open the commit", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const pop = new CommitsPopover();
    pop.open(anchor, CWD);
    await settle();

    document.querySelector('.cp-row[data-sha="a1b2c3d"] .cp-copy').click();
    await settle();

    expect(writeText).toHaveBeenCalledWith("a1b2c3d");
    expect(openInCodeMode).not.toHaveBeenCalled();
    expect(pop.isOpen).toBe(true);
    pop.close();
  });

  it("shows an empty state when the branch has no commits", async () => {
    ipcMock.impl = async () => ({ entries: [], has_more: false, has_upstream: false });
    const pop = new CommitsPopover();
    pop.open(anchor, CWD);
    await settle();

    expect(document.querySelector(".cp-empty").textContent).toContain("No commits on this branch yet");
    pop.close();
  });
});

function page(prefix, n, hasMore) {
  const entries = Array.from({ length: n }, (_, i) => ({
    short_sha: `${prefix}${String(i).padStart(4, "0")}`, message: `${prefix} ${i}`, pushed: true, timestamp: TS,
  }));
  return { entries, has_more: hasMore, has_upstream: true };
}

/** jsdom has no layout, so the list's scroll geometry is stubbed. */
function scrollList(scrollTop) {
  const list = document.querySelector(".cp-list");
  Object.defineProperty(list, "clientHeight", { value: 200, configurable: true });
  Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
  list.scrollTop = scrollTop;
  list.dispatchEvent(new Event("scroll"));
}

describe("CommitsPopover paging", () => {
  let anchor;
  let calls;
  beforeEach(() => {
    document.body.innerHTML = "";
    anchor = document.createElement("span");
    anchor.className = "sb-git-btn";
    document.body.appendChild(anchor);
    calls = [];
  });

  it("scrolling near the bottom fetches the next page at the current offset and appends it", async () => {
    ipcMock.impl = async (cmd, args) => {
      calls.push(args);
      return args.offset === 0 ? page("a", 30, true) : page("b", 5, false);
    };
    const pop = new CommitsPopover();
    pop.open(anchor, CWD);
    await settle();
    expect(document.querySelectorAll(".cp-row")).toHaveLength(30);
    expect(document.querySelector(".cp-sentinel.end")).toBeNull();

    scrollList(800);
    await settle();

    expect(calls.map((a) => a.offset)).toEqual([0, 30]);
    const rows = [...document.querySelectorAll(".cp-row")].map((r) => r.dataset.sha);
    expect(rows).toHaveLength(35);
    expect(rows[0]).toBe("a0000");
    expect(rows[34]).toBe("b0004");
    expect(document.querySelector(".cp-sentinel.end")).not.toBeNull();
    pop.close();
  });

  it("a scroll far from the bottom does not fetch", async () => {
    ipcMock.impl = async (cmd, args) => { calls.push(args); return page("a", 30, true); };
    const pop = new CommitsPopover();
    pop.open(anchor, CWD);
    await settle();

    scrollList(0);
    await settle();

    expect(calls).toHaveLength(1);
    pop.close();
  });

  it("a page from a closed popover never lands in the reopened one", async () => {
    let releaseStale;
    ipcMock.impl = (cmd, args) => {
      calls.push(args);
      if (calls.length === 1) return new Promise((r) => { releaseStale = () => r(page("stale", 3, false)); });
      return Promise.resolve(page("fresh", 2, false));
    };
    const pop = new CommitsPopover();
    pop.open(anchor, CWD);
    pop.close();
    pop.open(anchor, CWD);
    await settle();
    releaseStale();
    await settle();

    const rows = [...document.querySelectorAll(".cp-row")].map((r) => r.dataset.sha);
    expect(rows).toEqual(["fresh0000", "fresh0001"]);
    pop.close();
  });
});
