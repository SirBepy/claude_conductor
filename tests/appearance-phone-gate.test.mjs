// @vitest-environment jsdom
// todo 1023: Theme, Usage colors, Overlay and Background all persist via
// saveSettings(), which the daemon refuses from the phone - hidden there.
// Interface (sidebar animations) is localStorage-only and stays reachable.

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
  it("hides Theme/Usage colors/Overlay/Background, keeps Interface, when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderAppearanceView(root);
    expect(root.querySelector("#themeModToggle")).toBeNull();
    expect(root.querySelector("#colorApplyDashboard")).toBeNull();
    expect(root.querySelector("#overlayBackgroundStyle")).toBeNull();
    expect(root.querySelector("#backgroundFxEnabled")).toBeNull();
    expect(root.querySelector("#sidebarAnimations")).not.toBeNull();
    dispose();
  });

  it("shows every section when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderAppearanceView(root);
    expect(root.querySelector("#themeModToggle")).not.toBeNull();
    expect(root.querySelector("#colorApplyDashboard")).not.toBeNull();
    expect(root.querySelector("#overlayBackgroundStyle")).not.toBeNull();
    expect(root.querySelector("#backgroundFxEnabled")).not.toBeNull();
    expect(root.querySelector("#sidebarAnimations")).not.toBeNull();
    dispose();
  });
});
