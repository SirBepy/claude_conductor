// @vitest-environment jsdom

// Gaming mode's Settings toggle (Settings > Power & startup > "Gaming mode"). Pins:
// the toggle reflects get_gaming_mode's current state on open, flipping it
// calls set_gaming_mode with the opposite value, and the daemon's
// gaming_mode_changed broadcast (forwarded as the "gaming-mode-changed"
// Tauri event) re-syncs the checkbox even without a click - the scenario a
// phone toggle or a second window would produce.

import { describe, it, expect, vi, afterEach } from "vitest";

const { getGamingMode, setGamingMode } = vi.hoisted(() => ({
  getGamingMode: vi.fn(),
  setGamingMode: vi.fn(),
}));

let changedCb = null;
vi.mock("../src/shared/api.ts", () => ({
  api: {
    getGamingMode: (...a) => getGamingMode(...a),
    setGamingMode: (...a) => setGamingMode(...a),
    onGamingModeChanged: (cb) => {
      changedCb = cb;
      return () => { changedCb = null; };
    },
  },
}));

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}), setSettings: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));

const { renderPowerView } = await import("../src/views/settings/subviews/power/power.ts");

afterEach(() => {
  getGamingMode.mockReset();
  setGamingMode.mockReset();
  changedCb = null;
  document.body.innerHTML = "";
});

function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function toggle(root) {
  return root.querySelector("#gamingModeToggle");
}

describe("Power & startup > Gaming mode toggle", () => {
  it("reflects the daemon's current state on open", async () => {
    getGamingMode.mockResolvedValue({ on: true, paused_sessions: 2, stopped_procs: 1, stopped_containers: 0, docker_desktop_stopped: false });
    const root = mount();
    await renderPowerView(root);
    expect(toggle(root).checked).toBe(true);
  });

  it("flipping it off calls set_gaming_mode(false) and updates the checkbox from the response", async () => {
    getGamingMode.mockResolvedValue({ on: true, paused_sessions: 0, stopped_procs: 0, stopped_containers: 0, docker_desktop_stopped: false });
    setGamingMode.mockResolvedValue({ on: false, paused_sessions: 0, stopped_procs: 0, stopped_containers: 0, docker_desktop_stopped: false });
    const root = mount();
    await renderPowerView(root);
    expect(toggle(root).checked).toBe(true);

    toggle(root).dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setGamingMode).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(toggle(root).checked).toBe(false));
  });

  it("flipping it on calls set_gaming_mode(true)", async () => {
    getGamingMode.mockResolvedValue({ on: false, paused_sessions: 0, stopped_procs: 0, stopped_containers: 0, docker_desktop_stopped: false });
    setGamingMode.mockResolvedValue({ on: true, paused_sessions: 3, stopped_procs: 2, stopped_containers: 1, docker_desktop_stopped: true });
    const root = mount();
    await renderPowerView(root);
    expect(toggle(root).checked).toBe(false);

    toggle(root).dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setGamingMode).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(toggle(root).checked).toBe(true));
  });

  it("a gaming-mode-changed event from another client re-syncs the checkbox without a click", async () => {
    getGamingMode.mockResolvedValue({ on: false, paused_sessions: 0, stopped_procs: 0, stopped_containers: 0, docker_desktop_stopped: false });
    const root = mount();
    await renderPowerView(root);
    expect(toggle(root).checked).toBe(false);

    expect(changedCb).toBeTypeOf("function");
    changedCb({ on: true, paused_sessions: 5, stopped_procs: 0, stopped_containers: 0, docker_desktop_stopped: false });
    expect(toggle(root).checked).toBe(true);
  });
});
