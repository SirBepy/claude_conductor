// @vitest-environment jsdom
//
// Audit finding: saveSettings() did `setSettings(settings); void api.saveSettings(settings);`
// with no .catch - the in-memory state and UI both said "saved" even when the
// write to disk rejected, silently and permanently. These tests pin the fix:
// a failed write rolls the in-memory copy back to what was there before, and
// tells the user via the existing toast mechanism.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSettings, setSettings, saveSettingsApi, toastMock } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  saveSettingsApi: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("../src/shared/state.ts", () => ({
  getSettings: (...a) => getSettings(...a),
  setSettings: (...a) => setSettings(...a),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: { saveSettings: (...a) => saveSettingsApi(...a) },
}));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));

const { saveSettings } = await import("../src/shared/settings-save.ts");

const PREV = {
  theme: "void",
  extra: { someFutureKey: "keep-me" },
  projectAliases: {},
  projectBlacklist: [],
};

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  getSettings.mockReset().mockReturnValue(PREV);
  setSettings.mockReset();
  saveSettingsApi.mockReset();
  toastMock.mockReset();
});

describe("saveSettings - failed write rolls back and notifies", () => {
  it("applies the change optimistically, then rolls back to prev and toasts when the write rejects", async () => {
    saveSettingsApi.mockRejectedValue(new Error("disk full"));

    saveSettings();

    // Optimistic apply happens synchronously, before the write is known to
    // have landed.
    expect(setSettings).toHaveBeenCalledTimes(1);
    const optimistic = setSettings.mock.calls[0][0];
    expect(optimistic).not.toBe(PREV);
    // The unknown-key bag must survive the round-trip - a rollback that
    // dropped it would itself be data loss.
    expect(optimistic.extra).toEqual({ someFutureKey: "keep-me" });
    expect(toastMock).not.toHaveBeenCalled();

    await flushMicrotasks();

    expect(setSettings).toHaveBeenCalledTimes(2);
    expect(setSettings.mock.calls[1][0]).toBe(PREV);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatch(/save/i);
  });

  it("does not roll back or toast when the write succeeds", async () => {
    saveSettingsApi.mockResolvedValue(undefined);

    saveSettings();
    await flushMicrotasks();

    expect(setSettings).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalled();
  });
});
