// @vitest-environment jsdom
// Mute, notif cards and Output device persist via saveSettings(),
// which the daemon refuses from the phone - hidden there. The "This phone"
// sounds toggle is localStorage-only and phone-only. Voice dictation, mic and
// push-to-talk moved to the Voice page, character sounds to Characters.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}) }));

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const { renderNotificationsView } = await import(
  "../src/views/settings/subviews/notifications/notifications.ts"
);
const { NOTIF_TYPES } = await import("../src/shared/settings-save.ts");

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("notifications settings screen on the phone", () => {
  it("hides desktop-only controls, shows the This phone toggle, when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderNotificationsView(root);
    expect(root.querySelector("#muteAllSwitch")).toBeNull();
    expect(root.querySelector("#notifCards")).toBeNull();
    expect(root.querySelector("#audioOutputDevice")).toBeNull();
    expect(root.querySelector("#phoneSoundsSwitch")).not.toBeNull();
    dispose();
  });

  it("shows every desktop-only section when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderNotificationsView(root);
    expect(root.querySelector("#muteAllSwitch")).not.toBeNull();
    expect(root.querySelector("#notifCards")).not.toBeNull();
    // Hydration cloned one card per notification type into #notifCards.
    expect(root.querySelectorAll("#notifCards .notif-card").length).toBe(NOTIF_TYPES.length);
    expect(root.querySelector("#audioOutputDevice")).not.toBeNull();
    expect(root.querySelector("#phoneSoundsSwitch")).toBeNull();
    // Moved to the Voice and Characters pages.
    for (const id of ["#voiceDictationSwitch", "#audioInputDevice", "#pttCaptureBtn", "#characterSoundsSection", "#selectOnSessionClickSwitch", "#muteSystemSwitch"]) {
      expect(root.querySelector(id)).toBeNull();
    }
    expect(root.querySelector("h2").textContent).toBe("Notifications");
    dispose();
  });
});
