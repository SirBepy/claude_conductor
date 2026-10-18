// @vitest-environment jsdom
// todo 1023: persist() (auto-allow toggle + models input) has no try/catch
// and calls updateSettings, which the daemon refuses from the phone - both
// controls are gated out of the render there.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateSettings } from "../src/shared/settings-update.ts";

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}) }));
vi.mock("../src/shared/settings-update.ts", () => ({
  updateSettings: vi.fn(async (fn) => fn({})),
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadSort: () => "status",
  saveSort: vi.fn(),
}));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderChatDefaultsView } = await import(
  "../src/views/settings/subviews/chat-defaults/chat-defaults.ts"
);

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("chat defaults screen on the phone", () => {
  it("hides the auto-allow toggle and models input when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderChatDefaultsView(root);
    expect(root.querySelector("#chatDefaultsAutoAllow")).toBeNull();
    expect(root.querySelector("#chatDefaultsModels")).toBeNull();
    // Sort is local-storage only, not a settings write - stays reachable.
    expect(root.querySelector("#chatDefaultsSort")).not.toBeNull();
    dispose();
  });

  it("shows the auto-allow toggle and models input when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderChatDefaultsView(root);
    expect(root.querySelector("#chatDefaultsAutoAllow")).not.toBeNull();
    expect(root.querySelector("#chatDefaultsModels")).not.toBeNull();
    dispose();
  });
});

describe("auto-allow spawn toggles", () => {
  it("are desktop-only", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderChatDefaultsView(root);
    expect(root.querySelector("#chatDefaultsInheritAutoAllow")).toBeNull();
    expect(root.querySelector("#chatDefaultsWorkersAutoAllow")).toBeNull();
    dispose();
  });

  it("default on and save the daemon's setting keys", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderChatDefaultsView(root);
    const inherit = root.querySelector("#chatDefaultsInheritAutoAllow");
    const workers = root.querySelector("#chatDefaultsWorkersAutoAllow");
    expect(inherit.checked).toBe(true);
    expect(workers.checked).toBe(true);

    inherit.checked = false;
    inherit.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const saved = await updateSettings.mock.results.at(-1).value;
    expect(saved.spawnedChatsInheritAutoAccept).toBe(false);
    expect(saved.jarvisWorkersAutoAccept).toBe(true);
    dispose();
  });
});
