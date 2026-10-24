// @vitest-environment jsdom
// asserts: src/views/settings/subviews/power/power.ts, src/views/settings/subviews/data/data.ts, src/views/settings/subviews/shortcuts/shortcuts.ts, src/views/settings/subviews/accounts/accounts.ts, src/views/settings/subviews/permissions/permissions.ts, src/views/settings/subviews/chat-defaults/chat-defaults.ts
// "One job per page": the old System page is dissolved into Power & startup,
// Shortcuts and Data & storage; API keys sit on Accounts; the auto-allow
// toggles sit on Permissions. Phone gates are pinned here too.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}), setSettings: vi.fn() }));
vi.mock("../src/shared/settings-update.ts", () => ({
  updateSettings: vi.fn(async (fn) => fn({})),
}));
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => {
    if (cmd === "get_settings") return {};
    if (cmd === "list_accounts") return [];
    if (cmd === "list_api_keys") return [{ env_name: "FOO_KEY", label: "Foo", is_set: false }];
    if (cmd === "get_storage_info") return [];
    return null;
  }),
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadSort: () => "status",
  saveSort: vi.fn(),
}));

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const api = (await import("../src/shared/api.ts")).api;
vi.spyOn(api, "getGamingMode").mockResolvedValue({ on: false });
vi.spyOn(api, "onGamingModeChanged").mockImplementation(() => () => {});
vi.spyOn(api, "getStorageInfo").mockResolvedValue([]);
vi.spyOn(api, "listApiKeys").mockResolvedValue([{ env_name: "FOO_KEY", label: "Foo", is_set: false }]);
vi.spyOn(api, "listAccounts").mockResolvedValue([]);

const { renderPowerView } = await import("../src/views/settings/subviews/power/power.ts");
const { renderDataView } = await import("../src/views/settings/subviews/data/data.ts");
const { renderShortcutsView } = await import("../src/views/settings/subviews/shortcuts/shortcuts.ts");
const { renderAccountsSettingsView } = await import("../src/views/settings/subviews/accounts/accounts.ts");
const { renderPermissionsView } = await import("../src/views/settings/subviews/permissions/permissions.ts");
const { renderChatDefaultsView } = await import("../src/views/settings/subviews/chat-defaults/chat-defaults.ts");

async function mount(render) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await render(root);
  return { root, dispose };
}

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("Power & startup", () => {
  it("holds Launch at login and Gaming mode", async () => {
    const { root, dispose } = await mount(renderPowerView);
    expect(root.querySelector("#launchAtLogin")).not.toBeNull();
    expect(root.querySelector("#gamingModeToggle")).not.toBeNull();
    dispose();
  });

  it("on the phone keeps only Gaming mode", async () => {
    remote = true;
    const { root, dispose } = await mount(renderPowerView);
    expect(root.querySelector("#launchAtLogin")).toBeNull();
    expect(root.querySelector("#nightlyWhenDoneEnabled")).toBeNull();
    expect(root.querySelector("#gamingModeToggle")).not.toBeNull();
    dispose();
  });

  it("disposer stops listening for gaming mode changes", async () => {
    const unlisten = vi.fn();
    api.onGamingModeChanged.mockImplementationOnce(() => unlisten);
    const { dispose } = await mount(renderPowerView);
    dispose();
    expect(unlisten).toHaveBeenCalled();
  });
});

describe("Data & storage", () => {
  it("renders its section on desktop and nothing on the phone", async () => {
    let m = await mount(renderDataView);
    expect(m.root.querySelector("#dataSection")).not.toBeNull();
    m.dispose();
    remote = true;
    document.body.innerHTML = "";
    api.getStorageInfo.mockClear();
    m = await mount(renderDataView);
    expect(m.root.querySelector("#dataSection")).toBeNull();
    expect(api.getStorageInfo).not.toHaveBeenCalled();
    m.dispose();
  });
});

describe("Shortcuts", () => {
  it("shows Open chat 1-9 and New chat favorite 1-9 as single rows, with no Coming Soon", async () => {
    const { root, dispose } = await mount(renderShortcutsView);
    expect(root.querySelectorAll('[data-id="open-chat-"]').length).toBe(1);
    expect(root.querySelectorAll('[data-id="new-chat-favorite-"]').length).toBe(1);
    expect(root.querySelector('[data-id="open-chat-2"]')).toBeNull();
    expect(root.querySelector('[data-id="open-chat-"] .shortcut-kbd').textContent).toBe("Ctrl+1...9");
    expect(root.querySelector('[data-id="new-chat-favorite-"] .shortcut-kbd').textContent).toBe("Ctrl+Shift+1...9");
    expect(root.textContent).not.toContain("Coming Soon");
    dispose();
  });

  it("rebinding a range row takes only the captured modifiers", async () => {
    const { root, dispose } = await mount(renderShortcutsView);
    root.querySelector('[data-rebind="open-chat-"]').click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", altKey: true, bubbles: true, cancelable: true }));
    expect(root.querySelector('[data-id="open-chat-"] .shortcut-kbd').textContent).toBe("Alt+1...9");
    root.querySelector('[data-reset="open-chat-"]').click();
    expect(root.querySelector('[data-id="open-chat-"] .shortcut-kbd').textContent).toBe("Ctrl+1...9");
    expect(root.querySelector('[data-reset="open-chat-"]')).toBeNull();
    dispose();
  });
});

describe("Accounts API keys", () => {
  it("lists API keys after the accounts sections on desktop", async () => {
    const { root, dispose } = await mount(renderAccountsSettingsView);
    expect(root.querySelector("#apiKeysSection")).not.toBeNull();
    expect(root.querySelector(".api-key-row")).not.toBeNull();
    dispose();
  });

  it("hides API keys on the phone", async () => {
    remote = true;
    api.listApiKeys.mockClear();
    const { root, dispose } = await mount(renderAccountsSettingsView);
    expect(root.querySelector("#apiKeysSection")).toBeNull();
    expect(api.listApiKeys).not.toHaveBeenCalled();
    dispose();
  });
});

describe("Permissions defaults", () => {
  it("holds the three auto-allow toggles above the remembered rules", async () => {
    const { root, dispose } = await mount(renderPermissionsView);
    for (const id of ["chatDefaultsAutoAllow", "chatDefaultsInheritAutoAllow", "chatDefaultsWorkersAutoAllow"]) {
      expect(root.querySelector(`#${id}`)).not.toBeNull();
    }
    const titles = [...root.querySelectorAll(".kit-section-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Defaults", "Remembered rules"]);
    dispose();
  });

  it("saves each toggle under the daemon's key", async () => {
    const { updateSettings } = await import("../src/shared/settings-update.ts");
    const { root, dispose } = await mount(renderPermissionsView);
    const t = root.querySelector("#chatDefaultsWorkersAutoAllow");
    t.checked = false;
    t.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const saved = await updateSettings.mock.results.at(-1).value;
    expect(saved.jarvisWorkersAutoAccept).toBe(false);
    dispose();
  });

  it("are absent on the phone", async () => {
    remote = true;
    const { root, dispose } = await mount(renderPermissionsView);
    expect(root.querySelector("#chatDefaultsAutoAllow")).toBeNull();
    expect(root.querySelector(".kit-section-title").textContent).toBe("Remembered rules");
    dispose();
  });
});

describe("Chat defaults after the split", () => {
  it("keeps Sort and Models and no moved control", async () => {
    const { root, dispose } = await mount(renderChatDefaultsView);
    expect(root.querySelector("#chatDefaultsSort")).not.toBeNull();
    expect(root.querySelector("#chatDefaultsModels")).not.toBeNull();
    expect(root.querySelector("#chatDefaultsAutoAllow")).toBeNull();
    expect(root.querySelector("#chatDefaultsInheritAutoAllow")).toBeNull();
    expect(root.querySelector("#chatDefaultsWorkersAutoAllow")).toBeNull();
    expect(root.querySelector("#chatDefaultsBrowser")).toBeNull();
    dispose();
  });
});
