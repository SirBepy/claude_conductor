// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "lit-html";

// The App lock picker only exists inside the Android app, shows the phone's
// stored window, and writes a change straight back to the shell.

const { appLockSectionTemplate } = await import("../src/views/settings/subviews/remote-access/app-lock-section.ts");

function mount() {
  const host = document.createElement("div");
  render(appLockSectionTemplate(), host);
  return host;
}

describe("App lock section", () => {
  afterEach(() => {
    delete window.ConductorLock;
  });

  it("is absent without the shell's lock bridge", () => {
    expect(mount().querySelector("#ra-app-lock-section")).toBeNull();
  });

  it("selects the phone's stored window", () => {
    window.ConductorLock = { getRelockMinutes: () => 30, setRelockMinutes: vi.fn() };
    const select = mount().querySelector("#ra-app-lock-minutes");
    expect(select.value).toBe("30");
  });

  it("saves a new choice to the shell", () => {
    const setRelockMinutes = vi.fn();
    window.ConductorLock = { getRelockMinutes: () => 10, setRelockMinutes };
    const select = mount().querySelector("#ra-app-lock-minutes");
    select.value = "60";
    select.dispatchEvent(new Event("change"));
    expect(setRelockMinutes).toHaveBeenCalledWith(60);
  });
});
