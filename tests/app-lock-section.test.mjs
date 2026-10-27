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
    delete window.__ccLockSwitchResult;
  });

  it("is absent without the shell's lock bridge", () => {
    expect(mount().querySelector("#ra-app-lock-section")).toBeNull();
  });

  it("selects the phone's stored window", () => {
    window.ConductorLock = { getRelockMinutes: () => 30, setRelockMinutes: vi.fn() };
    const select = mount().querySelector("#ra-app-lock-minutes");
    expect(select.value).toBe("30");
  });

  const optionValues = (host) =>
    [...host.querySelectorAll("#ra-app-lock-minutes option")].map((o) => o.value);

  it("builds the options from the shell's list", () => {
    window.ConductorLock = {
      getRelockMinutes: () => 15,
      setRelockMinutes: vi.fn(),
      getRelockChoices: () => JSON.stringify({ default: 15, choices: [0, 15, 120] }),
    };
    const host = mount();
    expect(optionValues(host)).toEqual(["0", "15", "120"]);
    expect(host.querySelector("#ra-app-lock-minutes").value).toBe("15");
    expect([...host.querySelectorAll("#ra-app-lock-minutes option")].map((o) => o.textContent)).toEqual([
      "Every time", "After 15 minutes", "After 2 hours",
    ]);
  });

  it("falls back to the built-in list on an older shell or a bad payload", () => {
    window.ConductorLock = { getRelockMinutes: () => 10, setRelockMinutes: vi.fn() };
    expect(optionValues(mount())).toEqual(["0", "1", "5", "10", "30", "60"]);
    window.ConductorLock = { getRelockMinutes: () => 10, setRelockMinutes: vi.fn(), getRelockChoices: () => "nope" };
    expect(optionValues(mount())).toEqual(["0", "1", "5", "10", "30", "60"]);
  });

  describe("lock switch", () => {
    const shell = (over) => ({
      getRelockMinutes: () => 10,
      setRelockMinutes: vi.fn(),
      isLockEnabled: () => true,
      setLockEnabled: vi.fn(),
      hasScreenLock: () => true,
      ...over,
    });

    it("shows on and leaves the picker usable", () => {
      window.ConductorLock = shell();
      const host = mount();
      expect(host.querySelector("#ra-app-lock-enabled").checked).toBe(true);
      expect(host.querySelector("#ra-app-lock-minutes").disabled).toBe(false);
    });

    it("shows off and disables the picker", () => {
      window.ConductorLock = shell({ isLockEnabled: () => false });
      const host = mount();
      expect(host.querySelector("#ra-app-lock-enabled").checked).toBe(false);
      expect(host.querySelector("#ra-app-lock-minutes").disabled).toBe(true);
    });

    it("saves a flip and toggles the picker", () => {
      const setLockEnabled = vi.fn();
      window.ConductorLock = shell({ setLockEnabled });
      const host = mount();
      const sw = host.querySelector("#ra-app-lock-enabled");
      sw.checked = false;
      sw.dispatchEvent(new Event("change"));
      expect(setLockEnabled).toHaveBeenCalledWith(false);
      expect(host.querySelector("#ra-app-lock-minutes").disabled).toBe(true);
    });

    // The shell returns false when it is asking for the fingerprint/PIN first and
    // answers later through window.__ccLockSwitchResult.
    function flipOffAwaitingUnlock() {
      const setLockEnabled = vi.fn(() => false);
      window.ConductorLock = shell({ setLockEnabled });
      const host = mount();
      const sw = host.querySelector("#ra-app-lock-enabled");
      sw.checked = false;
      sw.dispatchEvent(new Event("change"));
      return { host, sw, setLockEnabled };
    }

    it("holds the switch still while the unlock prompt is up", () => {
      const { sw, setLockEnabled } = flipOffAwaitingUnlock();
      expect(setLockEnabled).toHaveBeenCalledWith(false);
      expect(sw.disabled).toBe(true);
    });

    it("flips back on and keeps the picker usable when the unlock is cancelled", () => {
      const { host, sw } = flipOffAwaitingUnlock();
      window.__ccLockSwitchResult(false);
      expect(sw.checked).toBe(true);
      expect(sw.disabled).toBe(false);
      expect(host.querySelector("#ra-app-lock-minutes").disabled).toBe(false);
      expect(window.__ccLockSwitchResult).toBeUndefined();
    });

    it("stays off and disables the picker once the unlock passes", () => {
      const { host, sw } = flipOffAwaitingUnlock();
      window.__ccLockSwitchResult(true);
      expect(sw.checked).toBe(false);
      expect(sw.disabled).toBe(false);
      expect(host.querySelector("#ra-app-lock-minutes").disabled).toBe(true);
    });

    it("turning the lock on needs no unlock", () => {
      const setLockEnabled = vi.fn(() => true);
      window.ConductorLock = shell({ isLockEnabled: () => false, setLockEnabled });
      const host = mount();
      const sw = host.querySelector("#ra-app-lock-enabled");
      sw.checked = true;
      sw.dispatchEvent(new Event("change"));
      expect(sw.disabled).toBe(false);
      expect(host.querySelector("#ra-app-lock-minutes").disabled).toBe(false);
      expect(window.__ccLockSwitchResult).toBeUndefined();
    });

    it("is disabled with a caption when the phone has no screen lock", () => {
      window.ConductorLock = shell({ hasScreenLock: () => false, isLockEnabled: () => false });
      const host = mount();
      expect(host.querySelector("#ra-app-lock-enabled").disabled).toBe(true);
      expect(host.querySelector("#ra-app-lock-no-screen-lock").textContent).toContain("screen lock");
    });

    it("is hidden on a shell without the switch methods", () => {
      window.ConductorLock = { getRelockMinutes: () => 10, setRelockMinutes: vi.fn() };
      const host = mount();
      expect(host.querySelector("#ra-app-lock-enabled")).toBeNull();
      expect(host.querySelector("#ra-app-lock-minutes").disabled).toBe(false);
    });
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
