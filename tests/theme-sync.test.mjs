// @vitest-environment jsdom

// The Chats window (and detached/Code windows) are separate webview realms:
// a theme picked in the main window's Settings must reach them through the
// app-wide settings-changed event, or they keep the theme they booted with.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const bgfx = vi.fn();
vi.mock("../src/shared/background-fx.ts", () => ({ applyBackgroundFx: (...a) => bgfx(...a) }));

const { applyAppearance, followAppearanceChanges } = await import("../src/shared/theme-sync.ts");

let handlers;

beforeEach(() => {
  handlers = {};
  bgfx.mockClear();
  document.documentElement.dataset.theme = "void";
  document.documentElement.dataset.mode = "dark";
  window.__TAURI__ = {
    event: {
      listen: (name, cb) => {
        handlers[name] = cb;
        return Promise.resolve(() => { delete handlers[name]; });
      },
    },
  };
});

afterEach(() => {
  delete window.__TAURI__;
});

describe("applyAppearance", () => {
  it("splits a -light id into palette + light mode", () => {
    applyAppearance({ theme: "tokyonight-light" });
    expect(document.documentElement.dataset.theme).toBe("tokyonight");
    expect(document.documentElement.dataset.mode).toBe("light");
  });

  it("falls back to void dark with no theme saved", () => {
    document.documentElement.dataset.theme = "nord";
    applyAppearance({});
    expect(document.documentElement.dataset.theme).toBe("void");
    expect(document.documentElement.dataset.mode).toBe("dark");
  });

  it("paints the animated background from the same settings", () => {
    applyAppearance({ theme: "void", backgroundEnabled: true, backgroundVariant: "gradient" });
    expect(bgfx).toHaveBeenCalledWith(true, "gradient");
  });
});

describe("followAppearanceChanges", () => {
  it("repaints the theme when settings-changed fires", () => {
    followAppearanceChanges();
    expect(handlers["settings-changed"]).toBeTypeOf("function");

    handlers["settings-changed"]({ payload: { theme: "gruvbox-light" } });
    expect(document.documentElement.dataset.theme).toBe("gruvbox");
    expect(document.documentElement.dataset.mode).toBe("light");

    handlers["settings-changed"]({ payload: { theme: "dracula" } });
    expect(document.documentElement.dataset.theme).toBe("dracula");
    expect(document.documentElement.dataset.mode).toBe("dark");
  });

  it("stops repainting after unlisten", async () => {
    const unlisten = followAppearanceChanges();
    unlisten();
    await Promise.resolve();
    expect(handlers["settings-changed"]).toBeUndefined();
  });

  it("is a no-op without the Tauri runtime", () => {
    delete window.__TAURI__;
    expect(() => followAppearanceChanges()()).not.toThrow();
  });
});
