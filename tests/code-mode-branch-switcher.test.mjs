// @vitest-environment jsdom

// Code mode's branch list (lifted out of the git card): filter, real checkout
// on pick, git's refusal surfaced, and the two warnings shown before a pick.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { BranchSwitcher } = await import("../src/views/sessions/code-mode/branch-switcher.ts");

const CWD = "C:\\repo";
const flush = () => new Promise((r) => setTimeout(r, 0));

const BRANCHES = [
  { name: "master", current: true, short_sha: "aaa1111", upstream: "origin/master" },
  { name: "feat/claim-state", current: false, short_sha: "bbb2222", upstream: null },
  { name: "fix/claim-retry", current: false, short_sha: "ccc3333", upstream: null },
];

function row(sessionId, cwd = CWD) {
  return { session_id: sessionId, pid: 1, cwd, project_id: "p", kind: "interactive", is_remote: false, started_at: "now", transcript_path: null, bridge_session_id: null, name: null, ended_at: null, end_reason: null };
}

/** Answers the switcher's own load; `extra` overrides or adds commands. */
function ipc(extra = () => undefined, calls = []) {
  return async (cmd, args) => {
    calls.push([cmd, args]);
    const v = await extra(cmd, args);
    if (v !== undefined) return v;
    if (cmd === "get_recent_branches") return BRANCHES;
    if (cmd === "get_git_dirty") return [];
    if (cmd === "list_instances") return [];
    return null;
  };
}

async function mount(opts = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const onCheckedOut = vi.fn();
  const onClose = vi.fn();
  const sw = new BranchSwitcher({ cwd: CWD, sessionId: null, onCheckedOut, onClose, ...opts });
  sw.mount(host);
  await flush();
  return { host, sw, onCheckedOut, onClose };
}

const pick = (host, name) => host.querySelector(`.sb-git-pop-row.pick[data-branch="${name}"]`);

beforeEach(() => {
  document.body.innerHTML = "";
  ipcMock.impl = ipc();
});

describe("code mode branch switcher", () => {
  it("lists every branch, the current one marked and not pickable", async () => {
    const { host } = await mount();
    expect(host.querySelectorAll(".sb-git-pop-row").length).toBe(3);
    const current = host.querySelector(".sb-git-pop-row.current");
    expect(current.textContent).toContain("master");
    expect(current.getAttribute("role")).toBeNull();
    expect(pick(host, "feat/claim-state").getAttribute("role")).toBe("button");
    expect(pick(host, "feat/claim-state").tabIndex).toBe(0);
  });

  it("filters the list without rebuilding the search box", async () => {
    const { host } = await mount();
    const input = host.querySelector(".bs-search input");
    input.value = "claim";
    input.dispatchEvent(new Event("input"));
    const names = Array.from(host.querySelectorAll(".sb-git-pop-name"), (n) => n.textContent);
    expect(names).toEqual(["feat/claim-state", "fix/claim-retry"]);
    // Same node, so the caret position survived the filter.
    expect(host.querySelector(".bs-search input")).toBe(input);
  });

  it("checks out a branch on click and reports back", async () => {
    const calls = [];
    ipcMock.impl = ipc(() => undefined, calls);
    const { host, onCheckedOut } = await mount();
    pick(host, "feat/claim-state").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(calls).toContainEqual(["checkout_branch", { cwd: CWD, name: "feat/claim-state" }]);
    expect(onCheckedOut).toHaveBeenCalledTimes(1);
  });

  it("Enter on a focused branch row checks it out", async () => {
    const calls = [];
    ipcMock.impl = ipc(() => undefined, calls);
    const { host } = await mount();
    pick(host, "fix/claim-retry").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(calls).toContainEqual(["checkout_branch", { cwd: CWD, name: "fix/claim-retry" }]);
  });

  it("surfaces git's refusal text instead of forcing the checkout", async () => {
    ipcMock.impl = ipc((cmd) => {
      if (cmd === "checkout_branch") throw new Error("error: Your local changes to the following files would be overwritten by checkout");
    });
    const { host, onCheckedOut } = await mount();
    pick(host, "feat/claim-state").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(host.querySelector(".sb-git-pop-error").textContent).toContain("would be overwritten");
    expect(onCheckedOut).not.toHaveBeenCalled();
  });

  it("shows the dirty-tree warning before the user picks a branch", async () => {
    ipcMock.impl = ipc((cmd) => (cmd === "get_git_dirty" ? ["a.txt", "b.txt", "c.txt"] : undefined));
    const { host } = await mount();
    expect(host.querySelector(".gc-dirty-warn").textContent).toContain("3 uncommitted files will come with you");
  });

  it("warns, but does not block, when another session is live in the same repo", async () => {
    ipcMock.impl = ipc((cmd) => (cmd === "list_instances" ? [row("peer-session")] : undefined));
    const { host } = await mount({ sessionId: "own-session" });
    expect(host.querySelector(".gc-peer-warn").textContent).toContain("Another Conductor session is active in this repo");
    expect(pick(host, "feat/claim-state").getAttribute("role")).toBe("button");
  });

  it("does not warn when the only live session in this repo is this chat", async () => {
    ipcMock.impl = ipc((cmd) => (cmd === "list_instances" ? [row("own-session")] : undefined));
    const { host } = await mount({ sessionId: "own-session" });
    expect(host.querySelector(".gc-peer-warn")).toBeNull();
  });

  it("Esc in the search box asks to close", async () => {
    const { host, onClose } = await mount();
    host.querySelector(".bs-search input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("without onPreview there is no preview icon", async () => {
    const { host } = await mount();
    expect(host.querySelector(".bs-preview")).toBeNull();
  });

  it("the preview icon reports the branch without checking it out", async () => {
    const calls = [];
    ipcMock.impl = ipc(() => undefined, calls);
    const onPreview = vi.fn();
    const { host } = await mount({ onPreview });
    host.querySelector('.bs-preview[data-preview="feat/claim-state"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(onPreview).toHaveBeenCalledWith("feat/claim-state");
    expect(calls.some(([cmd]) => cmd === "checkout_branch")).toBe(false);
  });

  it("initialFilter pre-fills the search box, narrowing the list on mount", async () => {
    const { host } = await mount({ initialFilter: "claim-state" });
    const names = Array.from(host.querySelectorAll(".sb-git-pop-name"), (n) => n.textContent);
    expect(names).toEqual(["feat/claim-state"]);
    expect(host.querySelector(".bs-search input").value).toBe("claim-state");
  });
});
