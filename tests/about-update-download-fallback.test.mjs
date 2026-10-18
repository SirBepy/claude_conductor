// @vitest-environment jsdom

// On Mac, every non-idle update state (available/downloading/downloaded/error)
// shows a single "Download from GitHub" button. In the "error" state there is
// no known version, so the button must still open a usable URL instead of
// silently no-opping (todo: Joe reported clicking it did nothing on Mac).

import { describe, it, expect, vi } from "vitest";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({
  api: { openExternal: (...a) => openExternal(...a) },
}));

const { deriveUpdateDeps } = await import("../src/views/settings/subviews/about/about.ts");

describe("deriveUpdateDeps on Mac", () => {
  it("falls back to the releases page when an errored check has no version", () => {
    const deps = deriveUpdateDeps({ state: "error" }, true);
    deps.onAction();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/SirBepy/claude_conductor/releases/latest",
    );
  });

  it("links to the specific tag when a version is known", () => {
    const deps = deriveUpdateDeps({ state: "available", version: "0.2.123" }, true);
    deps.onAction();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/SirBepy/claude_conductor/releases/tag/tauri-v0.2.123",
    );
  });
});
