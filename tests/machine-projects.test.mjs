// A paired machine's project list in the new-chat picker: the rows keep the
// peer's data (todo counts, worktrees) and only reuse its avatar when that
// avatar means the same thing on this machine.

import { describe, it, expect, vi } from "vitest";

const listMachineProjects = vi.fn();
vi.mock("../src/shared/api.ts", () => ({
  api: { listMachineProjects: (...a) => listMachineProjects(...a) },
}));

const {
  remoteGroupToRow, createMachineProjectsState, fetchMachineProjects, machineProjectStat,
} = await import("../src/views/sessions/components/machine-projects.ts");

function group(path, avatar) {
  return {
    id: "p", path, name: "widget", parent_segment: null, avatar,
    tokens_7d: 0, live: 0, any_automated: false,
    last_active_at: "2026-10-22T10:00:00Z", path_exists: true,
    worktrees: [{ path: `${path}-wt`, name: "wt", tokens_7d: 0, live: 0, last_active_at: null, path_exists: true }],
    last_worktree_path: null, last_start_folder_rel: null,
  };
}

describe("remoteGroupToRow", () => {
  it("keeps an emoji avatar, which reads the same on any machine", () => {
    const row = remoteGroupToRow(group("C:/w", { kind: "emoji", value: "🪶" }));
    expect(row.avatar).toEqual({ kind: "emoji", value: "🪶" });
  });

  it.each([
    ["an image path on the peer's disk", { kind: "image", value: "C:/peer/face.png" }],
    ["a character from a roster this machine may not have", { kind: "character", value: "fibo" }],
    ["no avatar", { kind: "none" }],
  ])("uses kind none for %s so the face placeholder hydrates through the peer", (_label, avatar) => {
    expect(remoteGroupToRow(group("C:/w", avatar)).avatar).toEqual({ kind: "none" });
  });

  it("carries the peer's worktrees and activity through untouched", () => {
    const row = remoteGroupToRow(group("C:/w", { kind: "none" }));
    expect(row.worktrees.map((w) => w.path)).toEqual(["C:/w-wt"]);
    expect(row.last_active_at).toBe("2026-10-22T10:00:00Z");
    expect(row.path_exists).toBe(true);
  });
});

describe("fetchMachineProjects", () => {
  it("stores the peer's groups and its todo counts, readable only for that machine", async () => {
    listMachineProjects.mockResolvedValueOnce({
      groups: [group("C:/w", { kind: "image", value: "C:/x.png" })],
      stats: { "C:/w": { mtime: 7, todoCount: 3 } },
    });
    const state = createMachineProjectsState();
    const onChange = vi.fn();
    fetchMachineProjects(state, "mach-win", () => false, onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

    expect(state.projects?.[0].avatar).toEqual({ kind: "none" });
    expect(machineProjectStat(state, "mach-win", "C:/w")).toEqual({ mtime: 7, todoCount: 3 });
    // The same path asked of another machine must not borrow these numbers.
    expect(machineProjectStat(state, "mach-other", "C:/w")).toBeUndefined();
  });

  it("clears the previous machine's stats the moment a different machine is picked", () => {
    const state = createMachineProjectsState();
    state.machineId = "mach-win";
    state.stats = { "C:/w": { mtime: 1, todoCount: 9 } };
    listMachineProjects.mockReturnValueOnce(new Promise(() => {}));
    fetchMachineProjects(state, "mach-linux", () => false, () => {});

    expect(machineProjectStat(state, "mach-win", "C:/w")).toBeUndefined();
    expect(machineProjectStat(state, "mach-linux", "C:/w")).toBeUndefined();
    expect(state.loading).toBe(true);
  });

  it("drops a response that arrives after the pick moved on", async () => {
    listMachineProjects.mockResolvedValueOnce({ groups: [group("C:/w", { kind: "none" })], stats: {} });
    const state = createMachineProjectsState();
    const onChange = vi.fn();
    fetchMachineProjects(state, "mach-win", () => true, onChange);
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).not.toHaveBeenCalled();
    expect(state.projects).toBeUndefined();
  });
});
