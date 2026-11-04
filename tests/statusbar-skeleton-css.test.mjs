// asserts: src/views/sessions/session-statusbar.css
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/views/sessions/session-statusbar.css", "utf8");

// The pending pane's statusbar placeholder must read as the real bar's frame
// with one centred shimmer pill, not the shared rounded edge-to-edge .v-skeleton block.
describe("statusbar skeleton placeholder", () => {
  const rule = css.match(/\.session-statusbar-host \.session-statusbar-skeleton\s*\{([^}]*)\}/);

  it("outranks .v-skeleton and drops its rounding and sweep", () => {
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/border-radius:\s*0/);
    expect(rule[1]).toMatch(/animation:\s*none/);
  });

  it("centres a single shimmer pill", () => {
    expect(rule[1]).toMatch(/justify-content:\s*center/);
    expect(rule[1]).toMatch(/align-items:\s*center/);
    expect(css).toMatch(/\.session-statusbar-skeleton::before\s*\{[^}]*animation:\s*v-shimmer/);
  });
});
