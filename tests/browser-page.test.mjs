// @vitest-environment jsdom
// The "Claude's browser" page: the switch persists
// claudeBrowserEnabled (read daemon-side by Settings::claude_browser_enabled),
// and there is no show/hide control for the daemon's window.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateSettings } from "../src/shared/settings-update.ts";
import { api } from "../src/shared/api.ts";

let settings = {};
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => settings }));
vi.mock("../src/shared/settings-update.ts", () => ({
  updateSettings: vi.fn(async (fn) => fn({})),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    browserStatus: vi.fn(async () => ({ running: false })),
    openInExplorer: vi.fn(async () => {}),
  },
}));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderBrowserView } = await import(
  "../src/views/settings/subviews/browser/browser.ts"
);

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderBrowserView(root);
  return { root, dispose };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  remote = false;
  settings = {};
  document.body.innerHTML = "";
  // A failed assertion in a fake-timer test must not leave the next test on fake timers.
  vi.useRealTimers();
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
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(updateSettings).toHaveBeenCalled();
    const saved = await updateSettings.mock.results.at(-1).value;
    expect(saved.claudeBrowserEnabled).toBe(true);
    dispose();
  });

  it("has no Show/Hide control: Claude's browser is just a normal window", async () => {
    const { root, dispose } = await mount();
    await flush();
    expect(root.querySelector("#chatDefaultsBrowserShow")).toBeNull();
    expect(api.browserSetShown).toBeUndefined();
    dispose();
  });

  it("is absent on the phone, where the window would open on the PC", async () => {
    remote = true;
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowser")).toBeNull();
    expect(root.querySelector("#chatDefaultsBrowserShow")).toBeNull();
    expect(root.querySelector("#chatDefaultsBrowserMode")).toBeNull();
    expect(api.browserStatus).not.toHaveBeenCalled();
    dispose();
  });
});

describe("My browser mode", () => {
  it("labels the select as the browser chats start on, since a chat can switch itself", async () => {
    const { root, dispose } = await mount();
    const row = root.querySelector("#chatDefaultsBrowserMode").closest(".kit-row");
    expect(row.textContent).toContain("Chats start on");
    dispose();
  });

  it("defaults to Claude's own browser, with no app or profile rows", async () => {
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowserMode").value).toBe("own");
    expect(root.querySelector("#chatDefaultsBrowserApp")).toBeNull();
    expect(root.querySelector("#chatDefaultsBrowserProfile")).toBeNull();
    dispose();
  });

  it("shows the app and profile rows when the settings say mine", async () => {
    settings = { claudeBrowserMode: "mine", claudeBrowserMineApp: "brave", claudeBrowserMineProfile: "Profile 2" };
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowserMode").value).toBe("mine");
    expect(root.querySelector("#chatDefaultsBrowserApp").value).toBe("brave");
    expect(root.querySelector("#chatDefaultsBrowserProfile").value).toBe("Profile 2");
    expect(root.querySelector("#chatDefaultsBrowserShow")).toBeNull();
    dispose();
  });

  it("saves a typed profile folder without waiting for blur", async () => {
    vi.useFakeTimers();
    settings = { claudeBrowserMode: "mine" };
    const { root, dispose } = await mount();
    const input = root.querySelector("#chatDefaultsBrowserProfile");
    input.value = "Profile 7";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(updateSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0][0]({}).claudeBrowserMineProfile).toBe("Profile 7");
    vi.useRealTimers();
    dispose();
  });

  it("flushes a profile edit still inside the debounce window when the page is left", async () => {
    vi.useFakeTimers();
    settings = { claudeBrowserMode: "mine" };
    const { root, dispose } = await mount();
    const input = root.querySelector("#chatDefaultsBrowserProfile");
    input.value = "Profile 9";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(updateSettings).not.toHaveBeenCalled();
    dispose();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0][0]({}).claudeBrowserMineProfile).toBe("Profile 9");
    await vi.advanceTimersByTimeAsync(500);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("leaving the page with no pending edit saves nothing", async () => {
    settings = { claudeBrowserMode: "mine" };
    const { dispose } = await mount();
    dispose();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("an unknown app in the settings reads as Chrome", async () => {
    settings = { claudeBrowserMode: "mine", claudeBrowserMineApp: "firefox" };
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowserApp").value).toBe("chrome");
    dispose();
  });

  it("switching to My browser persists the mode and redraws the rows", async () => {
    const { root, dispose } = await mount();
    const mode = root.querySelector("#chatDefaultsBrowserMode");
    mode.value = "mine";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await flush();
    const saved = await updateSettings.mock.results.at(-1).value;
    expect(saved.claudeBrowserMode).toBe("mine");
    expect(root.querySelector("#chatDefaultsBrowserApp")).not.toBeNull();
    expect(root.querySelector("#chatDefaultsBrowserShow")).toBeNull();
    dispose();
  });

  it("switching back to Claude's own drops the app and profile rows", async () => {
    settings = { claudeBrowserMode: "mine" };
    const { root, dispose } = await mount();
    const mode = root.querySelector("#chatDefaultsBrowserMode");
    mode.value = "own";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await flush();
    expect(root.querySelector("#chatDefaultsBrowserApp")).toBeNull();
    dispose();
  });

  it("persists the app and a trimmed profile folder name", async () => {
    settings = { claudeBrowserMode: "mine" };
    const { root, dispose } = await mount();
    const app = root.querySelector("#chatDefaultsBrowserApp");
    app.value = "edge";
    app.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const profile = root.querySelector("#chatDefaultsBrowserProfile");
    profile.value = "  Profile 1 ";
    profile.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const saved = await updateSettings.mock.results.at(-1).value;
    expect(saved.claudeBrowserMineApp).toBe("edge");
    expect(saved.claudeBrowserMineProfile).toBe("Profile 1");
    dispose();
  });

  it("a save with the mode select absent keeps the saved mode", async () => {
    settings = { claudeBrowserMode: "mine" };
    const { root, dispose } = await mount();
    root.querySelector("#chatDefaultsBrowserMode").remove();
    const autoAllow = root.querySelector("#chatDefaultsBrowser");
    autoAllow.checked = !autoAllow.checked;
    autoAllow.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const saved = await updateSettings.mock.results.at(-1).value;
    expect(saved.claudeBrowserMode).toBe("mine");
    dispose();
  });

  it("shows which browsers have the bridge connected", async () => {
    settings = { claudeBrowserMode: "mine" };
    api.browserStatus.mockResolvedValueOnce({ running: false,bridgeConnected: ["Brave"], extensionDir: "C:/app/_up_/browser-extension" });
    const { root, dispose } = await mount();
    await flush();
    expect(root.querySelector("#chatDefaultsBrowserBridge").textContent).toBe("Connected: Brave");
    dispose();
  });

  it("says Not connected when no bridge is up", async () => {
    settings = { claudeBrowserMode: "mine" };
    api.browserStatus.mockResolvedValueOnce({ running: false,bridgeConnected: [], extensionDir: "C:/x" });
    const { root, dispose } = await mount();
    await flush();
    expect(root.querySelector("#chatDefaultsBrowserBridge").textContent).toBe("Not connected");
    dispose();
  });

  it("Open folder opens the bundled extension folder for Load unpacked", async () => {
    settings = { claudeBrowserMode: "mine", claudeBrowserMineApp: "brave" };
    api.browserStatus.mockResolvedValueOnce({ running: false,bridgeConnected: [], extensionDir: "C:/app/_up_/browser-extension" });
    const { root, dispose } = await mount();
    await flush();
    root.querySelector("#chatDefaultsBrowserExtFolder").click();
    expect(api.openInExplorer).toHaveBeenCalledWith("C:/app/_up_/browser-extension");
    expect(root.textContent).toContain("brave://extensions");
    dispose();
  });

  it("Open folder is disabled when the daemon cannot find the folder", async () => {
    settings = { claudeBrowserMode: "mine" };
    api.browserStatus.mockResolvedValueOnce({ running: false,bridgeConnected: [], extensionDir: null });
    const { root, dispose } = await mount();
    await flush();
    expect(root.querySelector("#chatDefaultsBrowserExtFolder").disabled).toBe(true);
    dispose();
  });

  it("has no token field any more", async () => {
    settings = { claudeBrowserMode: "mine" };
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowserToken")).toBeNull();
    dispose();
  });
});

describe("Script tool", () => {
  it("is off by default and persists claudeBrowserScriptTool when switched on", async () => {
    const { root, dispose } = await mount();
    const toggle = root.querySelector("#chatDefaultsBrowserScript");
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const saved = await updateSettings.mock.results.at(-1).value;
    expect(saved.claudeBrowserScriptTool).toBe(true);
    dispose();
  });
});

describe("browser page ownership", () => {
  it("lives only on the browser page, not on Chat defaults", async () => {
    const { renderChatDefaultsView } = await import(
      "../src/views/settings/subviews/chat-defaults/chat-defaults.ts"
    );
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderChatDefaultsView(root);
    expect(root.querySelector("#chatDefaultsBrowser")).toBeNull();
    expect(root.querySelector("#chatDefaultsBrowserMode")).toBeNull();
    dispose();
  });

  it("is titled Claude's browser", async () => {
    const { root, dispose } = await mount();
    expect(root.textContent).toContain("Claude's browser");
    dispose();
  });
});
