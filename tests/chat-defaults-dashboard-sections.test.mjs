// @vitest-environment jsdom
// asserts: src/views/settings/subviews/chat-defaults/chat-defaults.ts, src/views/sessions/chat-dashboard/chat-view-pref.ts, src/shared/chat/dashboard/dashboard-model.ts

// Settings > Chat defaults lists the dashboard cards Joe can switch: Links and
// files and the Preview window on, Changes off until he turns it on. A switch
// stores only his override under `dashboardSections` and tells open chats.

import { describe, it, expect, vi, beforeEach } from "vitest";

let stored = {};
const updateSettings = vi.fn(async (fn) => {
  stored = fn(stored);
  return stored;
});
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => stored }));
vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings }));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({ loadSort: () => "status", saveSort: vi.fn() }));
let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderChatDefaultsView } = await import("../src/views/settings/subviews/chat-defaults/chat-defaults.ts");
const { CHAT_VIEW_CHANGED } = await import("../src/views/sessions/chat-dashboard/chat-view-pref.ts");

beforeEach(() => {
  stored = {};
  remote = false;
  updateSettings.mockClear();
  document.body.innerHTML = "";
});

async function open() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderChatDefaultsView(root);
  return { root, dispose };
}

describe("dashboard section switches", () => {
  it("shows a switch per optional card with Changes off by default", async () => {
    const { root, dispose } = await open();
    expect(root.querySelector("#chatDefaultsSection-links").checked).toBe(true);
    expect(root.querySelector("#chatDefaultsSection-preview").checked).toBe(true);
    expect(root.querySelector("#chatDefaultsSection-drafts").checked).toBe(true);
    expect(root.querySelector("#chatDefaultsSection-changes").checked).toBe(false);
    dispose();
  });

  it("reflects what Joe saved", async () => {
    stored = { dashboardSections: { links: false, changes: true } };
    const { root, dispose } = await open();
    expect(root.querySelector("#chatDefaultsSection-links").checked).toBe(false);
    expect(root.querySelector("#chatDefaultsSection-changes").checked).toBe(true);
    dispose();
  });

  it("stores only the override, keeps the others, and tells open chats", async () => {
    stored = { dashboardSections: { preview: false } };
    const { root, dispose } = await open();
    let told = 0;
    document.addEventListener(CHAT_VIEW_CHANGED, () => { told += 1; });
    const sw = root.querySelector("#chatDefaultsSection-changes");
    sw.checked = true;
    sw.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(stored.dashboardSections).toEqual({ preview: false, changes: true });
    expect(told).toBe(1);
    dispose();
  });

  it("is not offered on the phone, which always draws Messages", async () => {
    remote = true;
    const { root, dispose } = await open();
    expect(root.querySelector("#chatDefaultsSection-changes")).toBeNull();
    dispose();
  });
});
