// @vitest-environment jsdom
// todo 1023: Mute, notif cards, Voice dictation/Output device, and Character
// sounds all persist via saveSettings(), which the daemon refuses from the
// phone - hidden there. Microphone and push-to-talk are localStorage-only and
// stay reachable; push-to-phone is the opposite case (phone-only already).

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
  it("hides desktop-only sound/voice controls, keeps mic/ptt, when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderNotificationsView(root);
    expect(root.querySelector("#muteAllSwitch")).toBeNull();
    expect(root.querySelector("#notifCards")).toBeNull();
    expect(root.querySelector("#voiceDictationSwitch")).toBeNull();
    expect(root.querySelector("#audioOutputDevice")).toBeNull();
    expect(root.querySelector("#characterSoundsSection")).toBeNull();
    // Local-only controls stay reachable.
    expect(root.querySelector("#audioInputDevice")).not.toBeNull();
    expect(root.querySelector("#pttCaptureBtn")).not.toBeNull();
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
    expect(root.querySelector("#voiceDictationSwitch")).not.toBeNull();
    expect(root.querySelector("#audioOutputDevice")).not.toBeNull();
    expect(root.querySelector("#characterSoundsSection")).not.toBeNull();
    expect(root.querySelector("#audioInputDevice")).not.toBeNull();
    expect(root.querySelector("#pttCaptureBtn")).not.toBeNull();
    dispose();
  });
});
