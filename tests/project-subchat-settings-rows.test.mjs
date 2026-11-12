// @vitest-environment jsdom

// Project settings > Subchats: "Check a sub's work". "Subs changing files" is
// gone (every writing sub gets its own worktree, 2026-11-12).
// Pins: the select shows the project's stored value (or the default when the
// project has none), changing it calls update_project with that single field
// via api.updateProject, a project with no config row is registered first, and
// a failed save puts the select back on what is stored.

import { describe, it, expect, vi, afterEach } from "vitest";

const { listProjects, updateProject, ensureProject } = vi.hoisted(() => ({
  listProjects: vi.fn(),
  updateProject: vi.fn(),
  ensureProject: vi.fn(),
}));

vi.mock("../src/shared/api.ts", () => ({
  api: {
    listProjects: (...a) => listProjects(...a),
    updateProject: (...a) => updateProject(...a),
    ensureProject: (...a) => ensureProject(...a),
  },
}));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
const rows = await import("../src/views/sessions/project-dashboard/project-config/rows.ts");
const { renderSubchatCheckRow } = rows;

const PROJECT = { id: "proj-alpha", path: "C:/proj/alpha" };

afterEach(() => {
  listProjects.mockReset();
  updateProject.mockReset();
  ensureProject.mockReset();
  document.body.innerHTML = "";
});

function mount() {
  const root = document.createElement("div");
  root.innerHTML = `<select id="subchatCheckSelect"></select>`;
  document.body.appendChild(root);
  return root;
}

const labels = (select) => [...select.options].map((o) => o.textContent);

describe("Project settings > Check a sub's work", () => {
  it("offers the two modes and defaults to facts and a reviewer", async () => {
    listProjects.mockResolvedValue([PROJECT]);
    const select = mount().querySelector("#subchatCheckSelect");
    await renderSubchatCheckRow("C:/proj/alpha");
    expect(labels(select)).toEqual(["Facts and a reviewer", "Facts only"]);
    expect(select.value).toBe("facts_and_reviewer");
  });

  it("shows the stored value", async () => {
    listProjects.mockResolvedValue([{ ...PROJECT, subchat_check: "facts_only" }]);
    const select = mount().querySelector("#subchatCheckSelect");
    await renderSubchatCheckRow("C:/proj/alpha");
    expect(select.value).toBe("facts_only");
  });

  it("saves a change as that one field on this project's id", async () => {
    listProjects.mockResolvedValue([PROJECT]);
    updateProject.mockResolvedValue(undefined);
    const select = mount().querySelector("#subchatCheckSelect");
    await renderSubchatCheckRow("C:/proj/alpha");
    select.value = "facts_only";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalledWith("proj-alpha", { subchat_check: "facts_only" }));
  });

  it("registers a project with no config row first", async () => {
    listProjects.mockResolvedValue([]);
    ensureProject.mockResolvedValue({ id: "proj-fresh", path: "C:/proj/alpha" });
    updateProject.mockResolvedValue(undefined);
    const select = mount().querySelector("#subchatCheckSelect");
    await renderSubchatCheckRow("C:/proj/alpha");
    select.value = "facts_only";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(ensureProject).toHaveBeenCalledWith("C:/proj/alpha"));
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalledWith("proj-fresh", { subchat_check: "facts_only" }));
  });

  it("falls back to what is stored when the save fails", async () => {
    listProjects.mockResolvedValue([PROJECT]);
    updateProject.mockRejectedValue(new Error("disk full"));
    const select = mount().querySelector("#subchatCheckSelect");
    await renderSubchatCheckRow("C:/proj/alpha");
    select.value = "facts_only";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalled());
    await vi.waitFor(() => expect(select.value).toBe("facts_and_reviewer"));
    expect(select.disabled).toBe(false);
  });
});

describe("Project settings > Subs changing files", () => {
  it("is gone: no row renders it, since every writing sub gets its own worktree", () => {
    expect(rows.renderSubchatWritersRow).toBeUndefined();
  });
});
