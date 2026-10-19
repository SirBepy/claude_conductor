// @vitest-environment jsdom

// The About page's update action is the same on every platform: a found
// update offers Download & Install, a downloaded one offers Install, and
// nothing links out to GitHub any more.

import { describe, it, expect, vi } from "vitest";

const { openExternal, downloadAndInstall, installUpdate } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  downloadAndInstall: vi.fn(),
  installUpdate: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    openExternal: (...a) => openExternal(...a),
    downloadAndInstall: (...a) => downloadAndInstall(...a),
    installUpdate: (...a) => installUpdate(...a),
  },
}));

const { deriveUpdateDeps } = await import("../src/views/settings/subviews/about/about.ts");

describe("deriveUpdateDeps", () => {
  it("offers Download & Install for an available update and never opens GitHub", () => {
    const deps = deriveUpdateDeps({ state: "available", version: "0.2.127" });
    expect(deps.actionLabel).toBe("Download & Install v0.2.127");
    deps.onAction();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("offers Install for a downloaded update", () => {
    const deps = deriveUpdateDeps({ state: "downloaded", version: "0.2.127" });
    expect(deps.actionLabel).toBe("Install v0.2.127");
    deps.onAction();
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows no action when up to date", () => {
    const deps = deriveUpdateDeps({ state: "up-to-date" });
    expect(deps.actionLabel).toBeUndefined();
  });
});
