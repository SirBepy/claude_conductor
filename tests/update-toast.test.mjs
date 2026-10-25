// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  version: "0.2.200",
  remote: false,
  cb: null,
  openExternal: vi.fn(() => Promise.resolve()),
  showToast: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    getAppVersion: () => Promise.resolve(h.version),
    openExternal: (...a) => h.openExternal(...a),
    onUpdateStateChange: (cb) => { h.cb = cb; return () => {}; },
  },
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => h.remote }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => h.showToast(...a) }));

const { setupUpdateToast } = await import("../src/shared/update-toast.ts");
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  h.remote = false;
  h.cb = null;
  h.showToast.mockClear();
  h.openExternal.mockClear();
});

describe("setupUpdateToast", () => {
  it("toasts on an installed update with its version and click opens the release page", () => {
    setupUpdateToast();
    h.cb({ state: "downloaded", version: "0.2.200" });
    expect(h.showToast).toHaveBeenCalledTimes(1);
    const [text, opts] = h.showToast.mock.calls[0];
    expect(text).toBe("Updated to v0.2.200, restart to apply");
    opts.onClick();
    expect(h.openExternal).toHaveBeenCalledWith(
      "https://github.com/SirBepy/claude_conductor/releases/tag/tauri-v0.2.200",
    );
  });

  it("ignores other states", () => {
    setupUpdateToast();
    h.cb({ state: "available", version: "0.2.200" });
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("toasts once on the first launch after a version change, not the next", async () => {
    localStorage.setItem("lastSeenAppVersion", "0.2.199");
    setupUpdateToast();
    await flush();
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast.mock.calls[0][0]).toBe("Updated to v0.2.200");
    h.showToast.mockClear();
    setupUpdateToast();
    await flush();
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("stays silent on a fresh install", async () => {
    setupUpdateToast();
    await flush();
    expect(h.showToast).not.toHaveBeenCalled();
    expect(localStorage.getItem("lastSeenAppVersion")).toBe("0.2.200");
  });

  it("shows nothing on the phone", async () => {
    h.remote = true;
    localStorage.setItem("lastSeenAppVersion", "0.2.199");
    setupUpdateToast();
    await flush();
    expect(h.cb).toBeNull();
    expect(h.showToast).not.toHaveBeenCalled();
  });
});
