// @vitest-environment jsdom
// persist() (the models input) has no try/catch and calls
// updateSettings, which the daemon refuses from the phone - the input is
// gated out of the render there. The auto-allow toggles that used to share
// this gate moved to Permissions (see settings-system-split.test.mjs).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}) }));
vi.mock("../src/shared/settings-update.ts", () => ({
  updateSettings: vi.fn(async (fn) => fn({})),
}));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderChatDefaultsView } = await import(
  "../src/views/settings/subviews/chat-defaults/chat-defaults.ts"
);

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("chat defaults screen on the phone", () => {
  it("hides the models input when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderChatDefaultsView(root);
    expect(root.querySelector("#chatDefaultsModels")).toBeNull();
    // Chat order is by age plus Joe's drag now, so there is no Sort control to keep reachable.
    expect(root.querySelector("#chatDefaultsSort")).toBeNull();
    dispose();
  });

  it("shows the models input when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderChatDefaultsView(root);
    expect(root.querySelector("#chatDefaultsModels")).not.toBeNull();
    dispose();
  });
});
