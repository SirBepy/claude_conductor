// @vitest-environment jsdom
// asserts: src/views/settings/subviews/chat-defaults/chat-defaults.ts, src/views/sessions/project-dashboard/project-config/rows.ts, src/views/sessions/project-dashboard/project-config/project-settings.ts
// The compaction setting round-trips: Settings > Chat defaults writes the
// global `autoCompact` entry, a project's config page writes that project's
// entry, and each shows the value in force (project over global over default).

import { describe, it, expect, vi, beforeEach } from "vitest";

let stored = {};
const updateSettings = vi.fn(async (fn) => {
  stored = fn(stored);
  return stored;
});
const { listProjects, ensureProject, getSettingsApi } = vi.hoisted(() => ({
  listProjects: vi.fn(),
  ensureProject: vi.fn(),
  getSettingsApi: vi.fn(),
}));
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => stored }));
vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings }));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({ loadSort: () => "status", saveSort: vi.fn() }));
let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    listProjects: (...a) => listProjects(...a),
    ensureProject: (...a) => ensureProject(...a),
    getSettings: (...a) => getSettingsApi(...a),
  },
}));

const { renderChatDefaultsView } = await import("../src/views/settings/subviews/chat-defaults/chat-defaults.ts");
const { renderCompactionRow } = await import("../src/views/sessions/project-dashboard/project-config/rows.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  stored = {};
  remote = false;
  updateSettings.mockClear();
  listProjects.mockReset();
  ensureProject.mockReset();
  getSettingsApi.mockReset().mockImplementation(async () => stored);
  document.body.innerHTML = "";
});

describe("Settings > Chat defaults > Compaction", () => {
  async function open() {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderChatDefaultsView(root);
    return { root, dispose };
  }

  it("shows the default (on, 300K) and what is saved", async () => {
    let { root, dispose } = await open();
    expect(root.querySelector("#chatDefaultsCompactOn").checked).toBe(true);
    expect(root.querySelector("#chatDefaultsCompactK").value).toBe("300");
    dispose();
    // jsdom's id lookup misses an element when an earlier root holds the same id.
    document.body.innerHTML = "";
    stored = { autoCompact: { on: false, tokens: 450000 } };
    ({ root, dispose } = await open());
    expect(root.querySelector("#chatDefaultsCompactOn").checked).toBe(false);
    expect(root.querySelector("#chatDefaultsCompactK").value).toBe("450");
    dispose();
  });

  it("the switch and the number write the global entry and keep other settings", async () => {
    stored = { nextActionChips: false, autoCompact: { projects: { p: { on: false } } } };
    const { root, dispose } = await open();
    const sw = root.querySelector("#chatDefaultsCompactOn");
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    await tick();
    const k = root.querySelector("#chatDefaultsCompactK");
    k.value = "250";
    k.dispatchEvent(new Event("change"));
    await tick();
    expect(stored.autoCompact).toEqual({ on: false, tokens: 250000, projects: { p: { on: false } } });
    expect(stored.nextActionChips).toBe(false);
    dispose();
  });

  it("refuses a number the daemon would ignore and puts the value in force back", async () => {
    stored = { autoCompact: { tokens: 200000 } };
    const { root, dispose } = await open();
    const k = root.querySelector("#chatDefaultsCompactK");
    for (const bad of ["0", "", "-3", "2.5"]) {
      k.value = bad;
      k.dispatchEvent(new Event("change"));
      await tick();
      expect(k.value).toBe("200");
    }
    expect(updateSettings).not.toHaveBeenCalled();
    dispose();
  });

  it("is not offered on the phone", async () => {
    remote = true;
    const { root, dispose } = await open();
    expect(root.querySelector("#chatDefaultsCompactOn")).toBeNull();
    dispose();
  });
});

describe("project config > Compaction", () => {
  const PROJECT = { id: "proj-a", path: "C:/proj/a" };
  function mount() {
    const root = document.createElement("div");
    root.innerHTML = `<input type="checkbox" id="compactOn"><input type="number" id="compactK">`;
    document.body.appendChild(root);
    return root;
  }

  it("shows the global value until the project sets its own", async () => {
    stored = { autoCompact: { on: false, tokens: 400000, projects: { "proj-a": { tokens: 150000 } } } };
    listProjects.mockResolvedValue([PROJECT]);
    const root = mount();
    await renderCompactionRow("C:/proj/a");
    expect(root.querySelector("#compactOn").checked).toBe(false);
    expect(root.querySelector("#compactK").value).toBe("150");
  });

  it("writes only this project's entry", async () => {
    stored = { autoCompact: { on: true, tokens: 300000 } };
    listProjects.mockResolvedValue([PROJECT]);
    const root = mount();
    await renderCompactionRow("C:/proj/a");
    const sw = root.querySelector("#compactOn");
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.autoCompact.projects).toEqual({ "proj-a": { on: false } }));
    expect(stored.autoCompact.on).toBe(true);
    await vi.waitFor(() => expect(root.querySelector("#compactOn").disabled).toBe(false));
    const k = root.querySelector("#compactK");
    k.value = "200";
    k.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.autoCompact.projects).toEqual({ "proj-a": { on: false, tokens: 200000 } }));
  });

  it("registers a project with no config first", async () => {
    listProjects.mockResolvedValue([]);
    ensureProject.mockResolvedValue({ id: "proj-new", path: "C:/proj/a" });
    const root = mount();
    await renderCompactionRow("C:/proj/a");
    const sw = root.querySelector("#compactOn");
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.autoCompact.projects).toEqual({ "proj-new": { on: false } }));
    // The list never matches this path (case, slashes, a worktree), so the redraw
    // must read the entry under the id ensure_project gave, not fall back to the global one.
    await vi.waitFor(() => expect(root.querySelector("#compactOn").disabled).toBe(false));
    expect(root.querySelector("#compactOn").checked).toBe(false);
  });
});
