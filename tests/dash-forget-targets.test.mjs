// @vitest-environment jsdom
//
// A repoint/hide in Folder mapping and a group edit must not leave the
// dashboard (or a fresh draft) on the old target.

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = [];
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => { calls.push(cmd); return cmd === "dashboard_list_targets" ? [] : null; }),
}));
const openDashboardPage = vi.fn(async () => {});
vi.mock("../src/views/sessions/project-dashboard/dashboard-page.ts", () => ({ openDashboardPage: (...a) => openDashboardPage(...a) }));
vi.mock("../src/views/sessions/project-dashboard/dashboard.ts", () => ({ mountDashboard: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm: vi.fn(async () => true) }));

vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => false }));

const { resolveTarget, forgetTargets } = await import("../src/views/sessions/project-dashboard/draft-dashboard.ts");
const { followFolderChange } = await import("../src/views/sessions/project-dashboard/project-config.ts");
const { projectItems } = await import("../src/views/sessions/project-dashboard/dash-menu.ts");

const listCalls = () => calls.filter((c) => c === "dashboard_list_targets").length;

beforeEach(() => { calls.length = 0; openDashboardPage.mockClear(); forgetTargets(); });

describe("forgetTargets", () => {
  it("makes the next resolveTarget refetch instead of reusing the 10s cache", async () => {
    await resolveTarget("C:/a");
    await resolveTarget("C:/a");
    expect(listCalls()).toBe(1);
    forgetTargets();
    await resolveTarget("C:/a");
    expect(listCalls()).toBe(2);
  });
});

describe("followFolderChange", () => {
  it("page mode: a repoint reopens the page on the new cwd and drops the cache", async () => {
    await resolveTarget("C:/a");
    const host = { ctx: () => ({ mode: "page" }), pane: () => document.createElement("div"), deselect: vi.fn() };
    followFolderChange(host, { repointedTo: "C:/b" });
    expect(openDashboardPage).toHaveBeenCalledWith("C:/b");
    await resolveTarget("C:/a");
    expect(listCalls()).toBe(2);
  });

  it("a hide leaves the dashboard", () => {
    const host = { ctx: () => ({ mode: "page" }), pane: () => document.createElement("div"), deselect: vi.fn() };
    followFolderChange(host, { hidden: true });
    expect(host.deselect).toHaveBeenCalled();
    expect(openDashboardPage).not.toHaveBeenCalled();
  });
});

describe("group delete", () => {
  it("clears the targets cache", async () => {
    await resolveTarget("C:/a");
    const host = {
      ctx: () => ({ snap: { target: { kind: "group", id: "g", name: "G", repos: [] } }, mode: "page" }),
      reload: vi.fn(), deselect: vi.fn(),
    };
    const del = projectItems(host, document.createElement("div")).find((i) => i.label === "Delete group");
    del.run();
    await vi.waitFor(() => expect(host.deselect).toHaveBeenCalled());
    await resolveTarget("C:/a");
    expect(listCalls()).toBe(2);
  });
});
