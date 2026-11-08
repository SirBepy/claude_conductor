// The palette's settings index is hand-kept; this is what stops it drifting.
// A renamed row would otherwise open its page and flash nothing.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_PAGES, SETTING_ENTRIES } from "../src/views/command-palette/settings-index.ts";

const SUBVIEWS = join(import.meta.dirname, "../src/views/settings/subviews");

function sourceOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(SUBVIEWS, dir));
  return out.join("\n");
}

const settingsRoot = readFileSync(join(import.meta.dirname, "../src/views/settings/settings.ts"), "utf8");

describe("settings index", () => {
  it("has a page for every nav row on the Settings root, and no extra", () => {
    const routes = [...settingsRoot.matchAll(/nav\("(settings-[a-z-]+)"\)/g)].map((m) => m[1]).sort();
    expect(SETTINGS_PAGES.map((p) => p.route).sort()).toEqual(routes);
  });

  it("marks the same pages desktop-only as the Settings root does", () => {
    for (const p of SETTINGS_PAGES) {
      const row = new RegExp(`desktop \\? navRow\\([^\\n]*nav\\("${p.route}"\\)`);
      expect(row.test(settingsRoot), p.route).toBe(p.desktopOnly === true);
    }
  });

  it("points each page at an existing subview folder", () => {
    for (const p of SETTINGS_PAGES) expect(() => sourceOf(p.dir), p.route).not.toThrow();
  });

  it("only lists settings of a known page, once each", () => {
    const routes = new Set(SETTINGS_PAGES.map((p) => p.route));
    const seen = new Set();
    for (const e of SETTING_ENTRIES) {
      expect(routes.has(e.route), e.label).toBe(true);
      const key = `${e.route}|${e.label}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("finds every setting's label in its page's source", () => {
    const byRoute = new Map(SETTINGS_PAGES.map((p) => [p.route, sourceOf(p.dir)]));
    for (const e of SETTING_ENTRIES) {
      expect(byRoute.get(e.route).includes(e.label), `${e.route}: "${e.label}"`).toBe(true);
    }
  });
});
