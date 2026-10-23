// The project list is shared by the Dashboard, the Today widget and the
// usage-chart view. The Dashboard's quieter title must stay scoped to
// .view-dashboard, or the other two pages shrink and lighten with it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/views/dashboard/dashboard.css", "utf8");

describe("project list title styling", () => {
  it("keeps the shared base at the title size and scopes the Dashboard's smaller one", () => {
    expect(css).toMatch(/^\.project-list-title \{ font-size: var\(--fs-title\); font-weight: 700;/m);
    expect(css).toMatch(/^\.view-dashboard \.project-list-title \{ font-size: 13px; font-weight: 600;/m);
    expect(css).not.toMatch(/^\.project-list-title \{ font-size: 13px/m);
  });
});
