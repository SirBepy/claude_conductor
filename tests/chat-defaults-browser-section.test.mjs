// @vitest-environment jsdom
// Chat defaults' "Claude's browser" section: the switch persists
// claudeBrowserEnabled (read daemon-side by Settings::claude_browser_enabled),
// and the Show button drives the daemon's off-screen window.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateSettings } from "../src/shared/settings-update.ts";
import { api } from "../src/shared/api.ts";

let settings = {};
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => settings }));
vi.mock("../src/shared/settings-update.ts", () => ({
  updateSettings: vi.fn(async (fn) => fn({})),
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadSort: () => "status",
  saveSort: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    browserStatus: vi.fn(async () => ({ running: false, shown: false })),
    browserSetShown: vi.fn(async (shown) => ({ ok: true, shown })),
  },
}));

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

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  remote = false;
  settings = {};
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Claude's browser section", () => {
  it("is off by default", async () => {
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowser").checked).toBe(false);
    dispose();
  });

  it("is on when the setting says so", async () => {
    settings = { claudeBrowserEnabled: true };
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowser").checked).toBe(true);
    dispose();
  });

  it("persists claudeBrowserEnabled when the switch flips", async () => {
    const { root, dispose } = await mount();
    const toggle = root.querySelector("#chatDefaultsBrowser");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    expect(updateSettings).toHaveBeenCalled();
    const saved = await updateSettings.mock.results.at(-1).value;
    expect(saved.claudeBrowserEnabled).toBe(true);
    dispose();
  });

  it("Show asks the daemon to show the window, then offers Hide", async () => {
    const { root, dispose } = await mount();
    const btn = root.querySelector("#chatDefaultsBrowserShow");
    await flush();
    expect(btn.textContent).toBe("Show");
    btn.click();
    await flush();
    expect(api.browserSetShown).toHaveBeenCalledWith(true);
    expect(btn.textContent).toBe("Hide");
    btn.click();
    await flush();
    expect(api.browserSetShown).toHaveBeenLastCalledWith(false);
    expect(btn.textContent).toBe("Show");
    dispose();
  });

  it("reads Hide when the window was left shown", async () => {
    api.browserStatus.mockResolvedValueOnce({ running: true, shown: true });
    const { root, dispose } = await mount();
    await flush();
    expect(root.querySelector("#chatDefaultsBrowserShow").textContent).toBe("Hide");
    dispose();
  });

  it("is absent on the phone, where the window would open on the PC", async () => {
    remote = true;
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowser")).toBeNull();
    expect(root.querySelector("#chatDefaultsBrowserShow")).toBeNull();
    expect(api.browserStatus).not.toHaveBeenCalled();
    dispose();
  });
});
