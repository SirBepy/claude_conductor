// @vitest-environment jsdom
// The "Claude's browser" page: the switch persists
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
vi.mock("../src/shared/api.ts", () => ({
  api: {
    browserStatus: vi.fn(async () => ({ running: false, shown: false })),
    browserSetShown: vi.fn(async (shown) => ({ ok: true, shown })),
    openExternal: vi.fn(async () => ({})),
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

  it("defaults to Claude's own browser, with the Show button and no app or profile rows", async () => {
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowserMode").value).toBe("own");
    expect(root.querySelector("#chatDefaultsBrowserShow")).not.toBeNull();
    expect(root.querySelector("#chatDefaultsBrowserApp")).toBeNull();
    expect(root.querySelector("#chatDefaultsBrowserProfile")).toBeNull();
    dispose();
  });

  it("shows the app and profile rows instead of Show when the settings say mine", async () => {
    settings = { claudeBrowserMode: "mine", claudeBrowserMineApp: "brave", claudeBrowserMineProfile: "Profile 2" };
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsBrowserMode").value).toBe("mine");
    expect(root.querySelector("#chatDefaultsBrowserApp").value).toBe("brave");
    expect(root.querySelector("#chatDefaultsBrowserProfile").value).toBe("Profile 2");
    expect(root.querySelector("#chatDefaultsBrowserShow")).toBeNull();
    dispose();
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

  it("switching back to Claude's own brings the Show button back, wired", async () => {
    settings = { claudeBrowserMode: "mine" };
    const { root, dispose } = await mount();
    const mode = root.querySelector("#chatDefaultsBrowserMode");
    mode.value = "own";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await flush();
    const btn = root.querySelector("#chatDefaultsBrowserShow");
    expect(btn).not.toBeNull();
    btn.click();
    await flush();
    expect(api.browserSetShown).toHaveBeenCalledWith(true);
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

  it("the install button opens the Playwright extension's store page", async () => {
    settings = { claudeBrowserMode: "mine" };
    const { root, dispose } = await mount();
    root.querySelector("#chatDefaultsBrowserInstall").click();
    expect(api.openExternal).toHaveBeenCalledWith(
      "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm",
    );
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
