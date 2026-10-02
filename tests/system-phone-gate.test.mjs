// @vitest-environment jsdom
// todo 1023: the "Launch at login" toggle calls saveSettings(), which the
// daemon refuses from the phone - hidden there, matching the already-gated
// nightly/API-keys sections in the same view.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}) }));

let remote = false;
// api.ts's invoke() reads getTransport() internally (refreshDataSection /
// refreshApiKeysSection below), so keep the rest of the real module and only
// override isRemote.
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const { renderSystemView } = await import(
  "../src/views/settings/subviews/system/system.ts"
);

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("system settings screen on the phone", () => {
  it("hides the launch-at-login toggle when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderSystemView(root);
    expect(root.querySelector("#launchAtLogin")).toBeNull();
    dispose();
  });

  // get_storage_info has no remote case, so rendering this section on the
  // phone only logged a RemoteUnavailableError over an empty card list.
  it("hides Data & storage and never asks for storage info when remote", async () => {
    remote = true;
    const api = (await import("../src/shared/api.ts")).api;
    const spy = vi.spyOn(api, "getStorageInfo");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderSystemView(root);
    expect(root.querySelector("#dataSection")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    dispose();
  });

  it("shows Data & storage when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderSystemView(root);
    expect(root.querySelector("#dataSection")).not.toBeNull();
    dispose();
  });

  it("shows the launch-at-login toggle when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderSystemView(root);
    expect(root.querySelector("#launchAtLogin")).not.toBeNull();
    dispose();
  });
});
