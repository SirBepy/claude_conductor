// "Add a project from GitHub" flow state (project-picker/github-add.ts): which
// terms are searchable, mine-then-public widening, stale replies, keyboard
// entry, and the clone hand-off back to the picker.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));

const {
  newGithubFlow, resetGithub, isSearchableTerm, searchGithub, searchPublic, cloneRepo, handleGithubKey,
} = await import("../src/views/sessions/project-picker/github-add.ts");

const hit = (full, extra = {}) => ({
  full_name: full, description: "", private: false, account: "me", stars: null, on_disk: null, ...extra,
});

function setup() {
  const state = { projectsRootStored: null, github: newGithubFlow() };
  const deps = { getLocalProjects: () => [], finish: vi.fn(), isMachineActive: () => false, renderModal: vi.fn() };
  return { state, deps, flow: state.github };
}
const key = (k) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

beforeEach(() => invoke.mockReset());

describe("isSearchableTerm", () => {
  it("accepts a folder-style name and an owner/repo pair", () => {
    expect(isSearchableTerm("hubbub")).toBe(true);
    expect(isSearchableTerm("my-app.v2")).toBe(true);
    expect(isSearchableTerm("SirBepy/hubbub")).toBe(true);
  });
  it("rejects paths, flags, spaces and over-long terms", () => {
    for (const bad of ["", "../evil", "-rf", "a b", "a/b/c", "a\\b", "x".repeat(101)]) {
      expect(isSearchableTerm(bad), bad).toBe(false);
    }
  });
});

describe("search", () => {
  it("shows your repos when any match", async () => {
    const { flow, deps } = setup();
    invoke.mockResolvedValueOnce({ status: "ok", items: [hit("me/hubbub")], failed_accounts: 0 });
    await searchGithub("hub", flow, deps);
    expect(invoke).toHaveBeenCalledWith("github_search_repos", { query: "hub", scope: "mine" });
    expect(flow.mode).toBe("mine");
    expect(flow.hits).toHaveLength(1);
  });

  it("widens to public on its own when none of the dev's repos match", async () => {
    const { flow, deps } = setup();
    invoke
      .mockResolvedValueOnce({ status: "ok", items: [], failed_accounts: 0 })
      .mockResolvedValueOnce({ status: "ok", items: [hit("them/hub-kit", { account: "" })], failed_accounts: 0 });
    await searchGithub("hub", flow, deps);
    expect(invoke.mock.calls.map((c) => c[1].scope)).toEqual(["mine", "public"]);
    expect(flow.mode).toBe("public");
  });

  it("ends on 'none' when public has nothing either", async () => {
    const { flow, deps } = setup();
    invoke.mockResolvedValue({ status: "ok", items: [], failed_accounts: 0 });
    await searchGithub("zzz", flow, deps);
    expect(flow.mode).toBe("none");
  });

  it("maps the daemon's sign-in and missing-gh statuses to their own states", async () => {
    const a = setup();
    invoke.mockResolvedValueOnce({ status: "not_signed_in", items: [], failed_accounts: 0 });
    await searchGithub("x", a.flow, a.deps);
    expect(a.flow.mode).toBe("noauth");
    const b = setup();
    invoke.mockResolvedValueOnce({ status: "gh_missing", items: [], failed_accounts: 0 });
    await searchGithub("x", b.flow, b.deps);
    expect(b.flow.mode).toBe("missing");
  });

  it("an RPC failure becomes an error state carrying the message", async () => {
    const { flow, deps } = setup();
    invoke.mockRejectedValueOnce("GitHub did not answer in time");
    await searchGithub("x", flow, deps);
    expect(flow.mode).toBe("error");
    expect(flow.error).toContain("did not answer");
  });

  it("a reply that lands after the dev changed the term is dropped", async () => {
    const { flow, deps } = setup();
    let resolve;
    invoke.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const pending = searchGithub("hub", flow, deps);
    resetGithub(flow); // typing in the search box does this
    resolve({ status: "ok", items: [hit("me/hubbub")], failed_accounts: 0 });
    await pending;
    expect(flow.mode).toBe("idle");
    expect(flow.hits).toHaveLength(0);
  });

  it("searchPublic asks for the public scope", async () => {
    const { flow, deps } = setup();
    invoke.mockResolvedValueOnce({ status: "ok", items: [hit("a/b", { account: "" })], failed_accounts: 0 });
    await searchPublic("b", flow, deps);
    expect(invoke).toHaveBeenCalledWith("github_search_repos", { query: "b", scope: "public" });
    expect(flow.mode).toBe("public");
  });
});

describe("clone", () => {
  it("resolves the picker with the folder the daemon returns, naming the account", async () => {
    const { flow, deps } = setup();
    invoke.mockResolvedValueOnce({ path: "C:\\p\\hubbub", name: "hubbub" });
    await cloneRepo(hit("me/hubbub", { account: "me" }), flow, deps);
    expect(invoke).toHaveBeenCalledWith("github_clone_repo", { fullName: "me/hubbub", account: "me" });
    expect(deps.finish).toHaveBeenCalledWith({ path: "C:\\p\\hubbub", name: "hubbub", machineId: null });
  });

  it("a failed clone stays in the picker as an error, never resolving it", async () => {
    const { flow, deps } = setup();
    invoke.mockRejectedValueOnce("clone failed: not found");
    await cloneRepo(hit("me/hubbub"), flow, deps);
    expect(deps.finish).not.toHaveBeenCalled();
    expect(flow.mode).toBe("error");
  });
});

describe("keyboard", () => {
  it("Enter starts the search only when no local row could take it", async () => {
    const a = setup();
    invoke.mockResolvedValue({ status: "ok", items: [hit("me/hub")], failed_accounts: 0 });
    expect(handleGithubKey(key("Enter"), "hub", false, a.state, a.deps)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(handleGithubKey(key("Enter"), "hub", true, a.state, a.deps)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("Enter does nothing for a term that is not searchable", () => {
    const { state, deps } = setup();
    expect(handleGithubKey(key("Enter"), "../evil", true, state, deps)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("arrows move the selection, clamped, and Enter clones the selected repo", async () => {
    const { state, deps, flow } = setup();
    flow.mode = "mine";
    flow.hits = [hit("me/a"), hit("me/b")];
    invoke.mockResolvedValue({ path: "C:\\p\\b", name: "b" });
    handleGithubKey(key("ArrowDown"), "x", true, state, deps);
    handleGithubKey(key("ArrowDown"), "x", true, state, deps);
    expect(flow.selected).toBe(1);
    handleGithubKey(key("ArrowUp"), "x", true, state, deps);
    handleGithubKey(key("ArrowUp"), "x", true, state, deps);
    expect(flow.selected).toBe(0);
    handleGithubKey(key("ArrowDown"), "x", true, state, deps);
    handleGithubKey(key("Enter"), "x", true, state, deps);
    await vi.waitFor(() => expect(deps.finish).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("github_clone_repo", { fullName: "me/b", account: "me" });
  });

  it("Escape steps back to the actions and does not bubble up to close the picker", () => {
    const { state, deps, flow } = setup();
    flow.mode = "mine";
    const e = key("Escape");
    expect(handleGithubKey(e, "x", true, state, deps)).toBe(true);
    expect(flow.mode).toBe("idle");
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("Escape in the idle state is left to the picker", () => {
    const { state, deps } = setup();
    expect(handleGithubKey(key("Escape"), "x", true, state, deps)).toBe(false);
  });
});
