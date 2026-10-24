// The project list is shared by the Dashboard, the Today widget and the
// usage-chart view. All three use the one title style, so no page-scoped
// override may shrink it on just one of them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/views/dashboard/dashboard.css", "utf8");

describe("project list title styling", () => {
  it("keeps one shared title size with no Dashboard-only override", () => {
    expect(css).toMatch(/^\.project-list-title \{ font-size: var\(--fs-title\); font-weight: 700;/m);
    expect(css).not.toMatch(/\.view-dashboard \.project-list-title/);
  });
});
