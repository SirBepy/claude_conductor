// @vitest-environment jsdom
// asserts: src/views/settings/subviews/usage-meter/usage-meter.ts, src/views/settings/subviews/voice/voice.ts, src/views/settings/subviews/characters/characters.ts
// "One job per page": Usage meter, Voice & dictation and Characters' Voice lines
// each hold the controls that used to crowd Appearance and Notifications.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}), setSettings: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({
  api: { getDefaultWhitelist: async () => ({ mode: "all" }), setDefaultWhitelist: async () => {} },
}));
vi.mock("../src/shared/whitelist-editor.ts", () => ({ renderWhitelistEditor: async () => {} }));

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const { renderUsageMeterView } = await import("../src/views/settings/subviews/usage-meter/usage-meter.ts");
const { renderVoiceView } = await import("../src/views/settings/subviews/voice/voice.ts");
const { renderCharactersSettingsView } = await import("../src/views/settings/subviews/characters/characters.ts");

async function mount(fn) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  await fn(root);
  return root;
}
const has = (root, ...ids) => ids.map((id) => root.querySelector(id) !== null);

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("Usage meter page", () => {
  it("renders the colour and overlay controls with clearer toggle labels", async () => {
    const root = await mount(renderUsageMeterView);
    expect(root.querySelector("h2").textContent).toBe("Usage meter");
    expect(has(root, "#paceBand", "#paceColorUnder", "#paceColorNearSafe", "#paceColorNearOver", "#paceColorOver",
      "#colorApplyDashboard", "#colorApplyOverlay", "#overlayBackgroundStyle", "#overlayOpacity")).toEqual(Array(9).fill(true));
    expect(root.textContent).toContain("Colour numbers on Dashboard");
    expect(root.textContent).toContain("Colour numbers in overlay");
  });

  it("is empty on the phone", async () => {
    remote = true;
    const root = await mount(renderUsageMeterView);
    expect(root.querySelector(".kit-section")).toBeNull();
  });
});

describe("Voice & dictation page", () => {
  it("renders dictation, microphone and push-to-talk", async () => {
    const root = await mount(renderVoiceView);
    expect(root.querySelector("h2").textContent).toBe("Voice & dictation");
    expect(has(root, "#voiceDictationSwitch", "#audioInputDevice", "#pttCaptureBtn")).toEqual([true, true, true]);
    expect(root.querySelector("#audioOutputDevice")).toBeNull();
  });

  it("keeps only mic and push-to-talk on the phone", async () => {
    remote = true;
    const root = await mount(renderVoiceView);
    expect(has(root, "#voiceDictationSwitch", "#audioInputDevice", "#pttCaptureBtn")).toEqual([false, true, true]);
  });
});

describe("Characters page voice lines", () => {
  it("shows both titled sections on the desktop", async () => {
    const root = await mount(renderCharactersSettingsView);
    const titles = [...root.querySelectorAll(".kit-section-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Default characters", "Voice lines"]);
    expect(has(root, "#soundSlotWorkFinished", "#soundSlotAnnoyed", "#selectOnSessionClickSwitch")).toEqual([true, true, true]);
  });

  it("hides the voice lines section on the phone", async () => {
    remote = true;
    const root = await mount(renderCharactersSettingsView);
    expect(root.querySelector("#characterSoundsSection")).toBeNull();
    expect(root.querySelector("#default-whitelist-host")).not.toBeNull();
  });
});
