// @vitest-environment jsdom
//
// renameProject updates the project first, so a failed update leaves the alias
// map (settings.json) untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = { projectAliases: {}, projects: [{ id: "p1", path: "C:/a" }] };
const { saveSettings, updateProject, ensureProject, askConfirm, doMerge } = vi.hoisted(() => ({
  saveSettings: vi.fn(), updateProject: vi.fn(), ensureProject: vi.fn(), askConfirm: vi.fn(), doMerge: vi.fn(),
}));
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => settings, getTokenHistory: () => [{ cwd: "C:/b" }] }));
vi.mock("../src/shared/settings-save.ts", () => ({ saveSettings }));
vi.mock("../src/shared/api.ts", () => ({ api: { updateProject, ensureProject } }));
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm }));
vi.mock("../src/shared/merges.ts", async (orig) => ({ ...(await orig()), doMerge }));
vi.mock("../src/shared/modal.ts", () => ({ closeHostCard: vi.fn(), modalCardSlot: vi.fn(), presentHostCard: vi.fn(), setBackdropCancel: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../src/views/sessions/project-dashboard/dashboard-page.ts", () => ({ openDashboardPage: vi.fn() }));
vi.mock("../src/views/sessions/project-dashboard/draft-dashboard.ts", () => ({
  forgetTargets: vi.fn(), mountDraftDashboard: vi.fn(), unmountDraftDashboard: vi.fn(),
}));

const { renameProject } = await import("../src/views/sessions/project-dashboard/project-config.ts");

beforeEach(() => {
  settings.projectAliases = {};
  for (const m of [saveSettings, updateProject, ensureProject, askConfirm, doMerge]) m.mockReset();
  updateProject.mockResolvedValue(undefined);
});

describe("renameProject", () => {
  it("updates the project with the name, then saves the alias", async () => {
    expect(await renameProject("C:/a", "Alpha")).toBe(true);
    expect(updateProject).toHaveBeenCalledWith("p1", { name: "Alpha" });
    expect(settings.projectAliases["C:/a"].name).toBe("Alpha");
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("a name another project has merges into it after a confirm", async () => {
    askConfirm.mockResolvedValue(true);
    expect(await renameProject("C:/a", "b")).toBe(true);
    expect(askConfirm).toHaveBeenCalled();
    expect(doMerge).toHaveBeenCalledWith(settings.projectAliases, "C:/a", "C:/b");
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("a declined merge changes nothing", async () => {
    askConfirm.mockResolvedValue(false);
    expect(await renameProject("C:/a", "b")).toBe(false);
    expect(doMerge).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("a rejected updateProject leaves settings un-renamed", async () => {
    updateProject.mockRejectedValue(new Error("boom"));
    await expect(renameProject("C:/a", "Alpha")).rejects.toThrow("boom");
    expect(saveSettings).not.toHaveBeenCalled();
    expect(settings.projectAliases["C:/a"]).toBeUndefined();
  });
});
