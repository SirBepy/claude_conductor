// @vitest-environment jsdom

// Gaming mode's per-project allowlist (the dashboard's Project settings popup >
// "Keep running in gaming mode"). Pins: the checkbox reflects the project's
// stored `keep_running_in_gaming_mode` flag, and flipping it calls
// update_project with that single field via api.updateProject - the same
// IPC path the sibling "Connectors" toggle on this subview already uses.

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
const { renderGamingModeRow } = await import(
  "../src/views/sessions/project-dashboard/project-config/rows.ts"
);

const PROJECT = { id: "proj-alpha", path: "C:/proj/alpha", keep_running_in_gaming_mode: false };

afterEach(() => {
  listProjects.mockReset();
  updateProject.mockReset();
  ensureProject.mockReset();
  document.body.innerHTML = "";
});

function mount() {
  const root = document.createElement("div");
  root.innerHTML = `<input type="checkbox" id="gamingModeKeepRunning">`;
  document.body.appendChild(root);
  return root;
}

describe("Project settings > Keep running in gaming mode", () => {
  it("reflects the project's stored flag", async () => {
    listProjects.mockResolvedValue([{ ...PROJECT, keep_running_in_gaming_mode: true }]);
    const root = mount();
    await renderGamingModeRow("C:/proj/alpha");
    expect(root.querySelector("#gamingModeKeepRunning").checked).toBe(true);
  });

  it("defaults unchecked for a project with no flag set", async () => {
    listProjects.mockResolvedValue([PROJECT]);
    const root = mount();
    await renderGamingModeRow("C:/proj/alpha");
    expect(root.querySelector("#gamingModeKeepRunning").checked).toBe(false);
  });

  it("checking it calls update_project with keep_running_in_gaming_mode: true for this project's id", async () => {
    listProjects.mockResolvedValue([PROJECT]);
    updateProject.mockResolvedValue(undefined);
    const root = mount();
    await renderGamingModeRow("C:/proj/alpha");

    const toggle = root.querySelector("#gamingModeKeepRunning");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(updateProject).toHaveBeenCalledWith("proj-alpha", { keep_running_in_gaming_mode: true }));
  });

  it("registers the project first via ensure_project when it has no ProjectConfig yet", async () => {
    listProjects.mockResolvedValue([]); // unregistered cwd, matches renameProject's own fallback
    ensureProject.mockResolvedValue({ id: "proj-fresh", path: "C:/proj/alpha" });
    updateProject.mockResolvedValue(undefined);
    const root = mount();
    await renderGamingModeRow("C:/proj/alpha");

    const toggle = root.querySelector("#gamingModeKeepRunning");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(ensureProject).toHaveBeenCalledWith("C:/proj/alpha"));
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalledWith("proj-fresh", { keep_running_in_gaming_mode: true }));
  });
});
