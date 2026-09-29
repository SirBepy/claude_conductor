// todo 1004: `save_settings` now REJECTS a save built from a stale generation
// (SETTINGS_STALE) instead of merging a fixed field allowlist - see
// src-tauri/src/settings/store.rs::reconcile_save. `updateSettings` is the one
// frontend seam every settings-writing call site should use instead of
// building from the frontend's own (possibly stale) `currentSettings` cache:
// it always reads fresh, reapplies the caller's `mutate`, and retries a
// rejected save against whatever is current by then.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, setSettingsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  setSettingsMock: vi.fn(),
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/state.ts", () => ({
  setSettings: (...a) => setSettingsMock(...a),
}));

const { updateSettings } = await import("../src/shared/settings-update.ts");

beforeEach(() => {
  invokeMock.mockReset();
  setSettingsMock.mockReset();
});

describe("updateSettings", () => {
  it("saves on the first try when nothing is stale", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") return { settings_generation: 1, autostart: false };
      if (cmd === "save_settings") return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });

    const result = await updateSettings((s) => ({ ...s, autostart: true }));

    expect(result.autostart).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2); // one get, one save - no retry
    expect(setSettingsMock).toHaveBeenCalledTimes(1);
    expect(setSettingsMock.mock.calls[0][0]).toEqual(result);
  });

  it("retries once on SETTINGS_STALE, reapplying mutate against the re-read copy", async () => {
    let reads = 0;
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") {
        reads += 1;
        // The second read reflects a daemon-owned field that changed after
        // the first read - the thing a stale save must not revert.
        return reads === 1
          ? { settings_generation: 1, default_account_id: "acct-1", autostart: false }
          : { settings_generation: 2, default_account_id: null, autostart: false };
      }
      if (cmd === "save_settings") {
        // Reject the save built from the first (now-stale) read; accept the
        // one built from the second.
        return reads === 1 ? Promise.reject("SETTINGS_STALE") : undefined;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });

    const result = await updateSettings((s) => ({ ...s, autostart: true }));

    expect(reads).toBe(2);
    expect(result.autostart, "the caller's edit is reapplied on retry").toBe(true);
    expect(result.default_account_id, "the daemon's concurrent change survives, not the stale value").toBeNull();
    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "save_settings");
    expect(saveCalls).toHaveLength(2);
    expect(setSettingsMock).toHaveBeenCalledTimes(1); // only the accepted save updates the cache
  });

  it("gives up after 3 attempts and throws, without ever updating the cache", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") return { settings_generation: 1 };
      if (cmd === "save_settings") return Promise.reject("SETTINGS_STALE");
      throw new Error(`unexpected invoke ${cmd}`);
    });

    await expect(updateSettings((s) => s)).rejects.toBe("SETTINGS_STALE");

    const getCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "get_settings");
    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "save_settings");
    expect(getCalls).toHaveLength(3);
    expect(saveCalls).toHaveLength(3);
    expect(setSettingsMock).not.toHaveBeenCalled();
  });

  it("propagates a non-stale error immediately, without retrying", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") return { settings_generation: 1 };
      if (cmd === "save_settings") return Promise.reject(new Error("disk full"));
      throw new Error(`unexpected invoke ${cmd}`);
    });

    await expect(updateSettings((s) => s)).rejects.toThrow("disk full");

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "save_settings");
    expect(saveCalls).toHaveLength(1);
    expect(setSettingsMock).not.toHaveBeenCalled();
  });

  it("lets mutate return void, saving the fresh copy as-is", async () => {
    const fresh = { settings_generation: 1, notifications: { a: 1 } };
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") return fresh;
      if (cmd === "save_settings") return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });

    const result = await updateSettings((s) => { s.notifications.a = 2; });

    expect(result).toBe(fresh);
    expect(result.notifications.a).toBe(2);
  });
});
