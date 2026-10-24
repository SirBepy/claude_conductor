// @vitest-environment jsdom
// Theme, Hide from screen capture and Background persist via
// saveSettings(), which the daemon refuses from the phone - hidden there.
// Sidebar animations is localStorage-only and stays reachable. Usage colors
// and Overlay moved to the Usage meter page.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}), setSettings: vi.fn() }));

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const { renderAppearanceView } = await import(
  "../src/views/settings/subviews/appearance/appearance.ts"
);

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("appearance settings screen on the phone", () => {
  it("hides Theme/Hide-from-capture/Background, keeps sidebar animations, when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderAppearanceView(root);
    expect(root.querySelector("#themePicker")).toBeNull();
    expect(root.querySelector("#hideInMeetingSwitch")).toBeNull();
    expect(root.querySelector("#backgroundFxEnabled")).toBeNull();
    expect(root.querySelector("#sidebarAnimations")).not.toBeNull();
    dispose();
  });

  it("shows every section when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderAppearanceView(root);
    expect(root.querySelector("#themePicker")).not.toBeNull();
    expect(root.querySelector("#hideInMeetingSwitch")).not.toBeNull();
    // Usage colors and the overlay controls live on the Usage meter page now.
    expect(root.querySelector("#colorApplyDashboard")).toBeNull();
    expect(root.querySelector("#paceBand")).toBeNull();
    expect(root.querySelector("#overlayBackgroundStyle")).toBeNull();
    expect(root.querySelector("#overlayOpacity")).toBeNull();
    expect(root.querySelector("#backgroundFxEnabled")).not.toBeNull();
    expect(root.querySelector("#sidebarAnimations")).not.toBeNull();
    dispose();
  });
});
