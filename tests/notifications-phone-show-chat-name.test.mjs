// @vitest-environment jsdom
// asserts: src/views/settings/subviews/notifications/notifications.ts
// The phone is refused saveSettings, so its "Show chat name in notifications"
// toggle must go through the dedicated single-key RPC and never a full save.

import { describe, it, expect, vi, beforeEach } from "vitest";

let settings = {};
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => settings }));
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => true };
});
const invoke = vi.fn(async () => ({ ok: true }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));
const saveSettings = vi.fn();
vi.mock("../src/shared/settings-save.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, saveSettings: (...a) => saveSettings(...a) };
});

const { renderNotificationsView } = await import(
  "../src/views/settings/subviews/notifications/notifications.ts"
);

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  await renderNotificationsView(root);
  return root.querySelector("#pushShowChatNamePhoneSwitch");
}

beforeEach(() => {
  settings = {};
  document.body.innerHTML = "";
  invoke.mockClear();
  saveSettings.mockClear();
});

describe("phone Show chat name toggle", () => {
  it("hydrates on when the key is absent, off when false", async () => {
    expect((await mount()).checked).toBe(true);
    document.body.innerHTML = "";
    settings = { pushShowChatName: false };
    expect((await mount()).checked).toBe(false);
  });

  it("calls set_push_show_chat_name with the new value and never saveSettings", async () => {
    const sw = await mount();
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    expect(invoke).toHaveBeenCalledWith("set_push_show_chat_name", { value: false });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  // jsdom has no PushManager, the same as the Android app's WebView.
  it("shows only the chat-name toggle inside the Android app", async () => {
    window.ConductorPush = { getHandle: () => "" };
    try {
      const sw = await mount();
      const section = document.querySelector("#push-section");
      expect(section.style.display).toBe("");
      expect(document.querySelector("#push-web-rows").style.display).toBe("none");
      expect(section.contains(sw)).toBe(true);
    } finally {
      delete window.ConductorPush;
    }
  });

  it("hides the whole section in a browser without push support", async () => {
    await mount();
    expect(document.querySelector("#push-section").style.display).toBe("none");
  });
});
