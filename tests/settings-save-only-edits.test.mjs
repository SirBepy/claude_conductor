// @vitest-environment jsdom
// asserts: src/shared/settings-save.ts
//
// pc-1455 review: a Settings page writes only the controls the user changed.
//
// - A page left open while a paired machine synced in a change to another of its
//   controls must not write that control's old value back (stamped as a fresh
//   local edit, it would win and revert the peer's change everywhere).
// - A fresh install's first save must not write the defaults its controls show
//   for keys that are absent, or those defaults get stamped as an edit and beat
//   an older machine's custom look on the first pair.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));

const { saveSettings, captureControlsBaseline } = await import("../src/shared/settings-save.ts");
const { setSettings } = await import("../src/shared/state.ts");

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function backend(settings) {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd) => {
    if (cmd === "get_settings") return structuredClone(settings);
    if (cmd === "save_settings") return undefined;
    throw new Error(`unexpected invoke ${cmd}`);
  });
}

function saved() {
  const call = invokeMock.mock.calls.filter(([cmd]) => cmd === "save_settings").at(-1);
  return call?.[1].updated;
}

function mountControls({ paceBand = "10", overlayChecked = true, style = "circles" } = {}) {
  document.body.innerHTML = `
    <input type="number" id="paceBand" value="${paceBand}">
    <input type="checkbox" id="colorApplyDashboard" checked>
    <input type="checkbox" id="colorApplyOverlay" ${overlayChecked ? "checked" : ""}>
    <input type="color" id="paceColorUnder" value="#27ae60">
    <input type="color" id="paceColorNearSafe" value="#f1c40f">
    <input type="color" id="paceColorNearOver" value="#e67e22">
    <input type="color" id="paceColorOver" value="#e74c3c">
    <select id="overlayBackgroundStyle"><option value="circles">c</option><option value="card">k</option></select>`;
  document.getElementById("overlayBackgroundStyle").value = style;
}

const base = { settings_generation: 1, theme: "void", projectAliases: {}, projectBlacklist: [] };

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-mode");
});

describe("a settings page writes only what the user changed", () => {
  it("a stale page does not revert a peer's change to a control the user did not touch", async () => {
    // The page opened when Pace band was 20 ...
    const opened = { ...base, paceBand: 20 };
    setSettings(opened);
    mountControls({ paceBand: "20" });
    captureControlsBaseline();
    // ... a paired machine then synced Pace band 30 in ...
    backend({ ...base, paceBand: 30, settings_generation: 2 });
    // ... and the user toggles an unrelated control.
    document.getElementById("colorApplyOverlay").checked = false;
    saveSettings();
    await flush();
    const out = saved();
    expect(out.paceBand).toBe(30);
    expect(out.colorApplyTo.overlay).toBe(false);
  });

  it("the control the user did edit still wins over the live value", async () => {
    setSettings({ ...base, paceBand: 20 });
    mountControls({ paceBand: "20" });
    captureControlsBaseline();
    backend({ ...base, paceBand: 30, settings_generation: 2 });
    document.getElementById("paceBand").value = "45";
    saveSettings();
    await flush();
    expect(saved().paceBand).toBe(45);
  });

  it("a second save does not revert the peer's change either", async () => {
    setSettings({ ...base, paceBand: 20 });
    mountControls({ paceBand: "20" });
    captureControlsBaseline();
    backend({ ...base, paceBand: 30, settings_generation: 2 });
    document.getElementById("colorApplyOverlay").checked = false;
    saveSettings();
    await flush();
    document.getElementById("colorApplyOverlay").checked = true;
    saveSettings();
    await flush();
    expect(saved().paceBand).toBe(30);
  });

  it("editing a control and then back to the value it started with still saves the revert", async () => {
    setSettings({ ...base, paceBand: 20 });
    mountControls({ paceBand: "20" });
    captureControlsBaseline();
    backend({ ...base, paceBand: 20 });
    document.getElementById("paceBand").value = "30";
    saveSettings();
    await flush();
    expect(saved().paceBand).toBe(30);
    // The backend now holds 30; the user puts the control back to its first value.
    backend({ ...base, paceBand: 30, settings_generation: 2 });
    document.getElementById("paceBand").value = "20";
    saveSettings();
    await flush();
    expect(saved().paceBand).toBe(20);
  });

  it("a fresh install's save writes no default for a key that is absent", async () => {
    setSettings({ ...base });
    mountControls();
    captureControlsBaseline();
    backend({ ...base });
    // Any control firing a save: the theme switch, say.
    saveSettings();
    await flush();
    const out = saved();
    for (const key of ["paceBand", "paceColors", "colorApplyTo", "overlayBackgroundStyle"]) {
      expect(key in out, `${key} must stay absent`).toBe(false);
    }
  });

  it("a fresh install's edit of one control writes that control only", async () => {
    setSettings({ ...base });
    mountControls();
    captureControlsBaseline();
    backend({ ...base });
    document.getElementById("overlayBackgroundStyle").value = "card";
    saveSettings();
    await flush();
    const out = saved();
    expect(out.overlayBackgroundStyle).toBe("card");
    for (const key of ["paceBand", "paceColors", "colorApplyTo"]) {
      expect(key in out, `${key} must stay absent`).toBe(false);
    }
  });

  it("editing one colour leaves the other colours to the live values", async () => {
    const live = { ...base, paceColors: { under: "#111111", nearSafe: "#222222", nearOver: "#333333", over: "#444444" } };
    setSettings(live);
    mountControls();
    document.getElementById("paceColorUnder").value = "#111111";
    document.getElementById("paceColorNearSafe").value = "#222222";
    document.getElementById("paceColorNearOver").value = "#333333";
    document.getElementById("paceColorOver").value = "#444444";
    captureControlsBaseline();
    // A peer changes "over" while the page is open; the user edits "under".
    backend({ ...live, paceColors: { ...live.paceColors, over: "#999999" }, settings_generation: 2 });
    document.getElementById("paceColorUnder").value = "#abcdef";
    saveSettings();
    await flush();
    expect(saved().paceColors).toEqual({ under: "#abcdef", nearSafe: "#222222", nearOver: "#333333", over: "#999999" });
  });
});
