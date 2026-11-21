// @vitest-environment jsdom
// asserts: src/views/settings/subviews/chat-defaults/chat-defaults.ts
// The "Hide idle chats" switch: on until Joe turns it off, and it writes the `autoHideIdleChats`
// settings key the daemon reads (`Settings::auto_hide_idle_chats`).

import { describe, it, expect, vi, beforeEach } from "vitest";

let stored = {};
const updateSettings = vi.fn(async (fn) => {
  stored = fn(stored);
  return stored;
});
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => stored }));
vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings }));
let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderChatDefaultsView } = await import(
  "../src/views/settings/subviews/chat-defaults/chat-defaults.ts"
);

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderChatDefaultsView(root);
  return { root, dispose };
}

beforeEach(() => {
  remote = false;
  stored = {};
  updateSettings.mockClear();
  document.body.innerHTML = "";
});

describe("hide idle chats switch", () => {
  it("is on by default", async () => {
    const { root, dispose } = await mount();
    const box = root.querySelector("#chatDefaultsAutoHide");
    expect(box).not.toBeNull();
    expect(box.checked).toBe(true);
    dispose();
  });

  it("shows off only for a stored false", async () => {
    stored = { autoHideIdleChats: false };
    let m = await mount();
    expect(m.root.querySelector("#chatDefaultsAutoHide").checked).toBe(false);
    m.dispose();
    document.body.innerHTML = "";
    stored = { autoHideIdleChats: "no" };
    m = await mount();
    expect(m.root.querySelector("#chatDefaultsAutoHide").checked).toBe(true);
    m.dispose();
  });

  it("writes the key the daemon reads, both ways, keeping the rest of the settings", async () => {
    stored = { keep: 1 };
    const { root, dispose } = await mount();
    const box = root.querySelector("#chatDefaultsAutoHide");
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.autoHideIdleChats).toBe(false));
    expect(stored.keep).toBe(1);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.autoHideIdleChats).toBe(true));
    dispose();
  });

  it("is drawn on the phone too, since the hidden list is shared", async () => {
    remote = true;
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsAutoHide")).not.toBeNull();
    dispose();
  });
});
