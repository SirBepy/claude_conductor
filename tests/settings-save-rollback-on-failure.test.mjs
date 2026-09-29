// @vitest-environment jsdom
//
// todo 1004: `saveSettings()` (the Settings panel's autosave) used to build
// its write from `getSettings()` - the frontend's own possibly-stale cache -
// then apply it with an optimistic `setSettings` + rollback-on-failure. That
// meant a save built from a stale snapshot could blind-overwrite (or, after
// 44295410's three-field merge, still partially overwrite) a daemon-owned
// field the panel never touches, e.g. `default_account_id` cleared by
// `remove_account` in between the panel's mount and the user's edit.
//
// `saveSettings()` now goes through `updateSettings`, which reads fresh
// settings right before saving (never the panel's own cache) and retries a
// `SETTINGS_STALE` rejection against whatever is current by then. These tests
// pin that: a daemon-side change to a field the panel doesn't own survives a
// panel save, and a genuine (non-stale) write failure still toasts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, toastMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));

const { saveSettings } = await import("../src/shared/settings-save.ts");

function baseSettings(overrides = {}) {
  return {
    settings_generation: 1,
    theme: "void",
    extra: { someFutureKey: "keep-me" },
    projectAliases: {},
    projectBlacklist: [],
    default_account_id: "acct-old",
    autostart: false,
    ...overrides,
  };
}

async function flushMicrotasks() {
  // A few ticks: updateSettings awaits get_settings, then save_settings,
  // possibly twice on a retry.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  invokeMock.mockReset();
  toastMock.mockReset();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-mode");
});

describe("saveSettings - stale-safe save path (todo 1004)", () => {
  it("a daemon-side change to a field the panel doesn't own survives the panel's save", async () => {
    // The backend's live state has already moved on by the time the panel's
    // autosave fires (e.g. remove_account cleared default_account_id and
    // bumped the generation) - the panel's own DOM-backed edit has nothing to
    // do with that field.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") {
        return baseSettings({ default_account_id: null, settings_generation: 2 });
      }
      if (cmd === "save_settings") return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });

    saveSettings();
    await flushMicrotasks();

    expect(toastMock).not.toHaveBeenCalled();
    const saveCall = invokeMock.mock.calls.find(([cmd]) => cmd === "save_settings");
    expect(saveCall).toBeTruthy();
    const [, args] = saveCall;
    expect(args.updated.default_account_id).toBeNull();
    // The unknown-key bag must survive the round-trip.
    expect(args.updated.extra).toEqual({ someFutureKey: "keep-me" });
  });

  it("retries a SETTINGS_STALE rejection and the retried save carries the daemon's concurrent change", async () => {
    let reads = 0;
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") {
        reads += 1;
        return reads === 1
          ? baseSettings({ settings_generation: 1, default_account_id: "acct-old" })
          : baseSettings({ settings_generation: 2, default_account_id: null });
      }
      if (cmd === "save_settings") {
        return reads === 1 ? Promise.reject("SETTINGS_STALE") : undefined;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });

    saveSettings();
    await flushMicrotasks();

    expect(toastMock).not.toHaveBeenCalled();
    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "save_settings");
    expect(saveCalls).toHaveLength(2);
    const [, finalArgs] = saveCalls[1];
    expect(finalArgs.updated.default_account_id).toBeNull();
  });

  it("toasts on a genuine (non-stale) write failure", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") return baseSettings();
      if (cmd === "save_settings") return Promise.reject(new Error("disk full"));
      throw new Error(`unexpected invoke ${cmd}`);
    });

    saveSettings();
    await flushMicrotasks();

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatch(/save/i);
  });

  it("does not toast when the write succeeds", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") return baseSettings();
      if (cmd === "save_settings") return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });

    saveSettings();
    await flushMicrotasks();

    expect(toastMock).not.toHaveBeenCalled();
  });
});
