// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { projBadgeHtml } from "../src/views/sessions/sidebar-row-visuals.ts";

describe("projBadgeHtml machine-aware project face", () => {
  it("stamps data-proj-face-machine for a session mirrored from a paired peer machine", () => {
    const html = projBadgeHtml("/Users/joe/repo", "session-proj-badge", "mac-mini-id");
    expect(html).toContain('data-proj-face-machine="mac-mini-id"');
    expect(html).toContain('data-proj-face="/Users/joe/repo"');
  });

  it("omits the attribute for a locally-hosted session (no machineId)", () => {
    const html = projBadgeHtml("C:\\Users\\tecno\\Desktop\\Projects\\countoff", "session-proj-badge");
    expect(html).not.toContain("data-proj-face-machine");
  });

  it("still returns empty for a null cwd, machineId or not", () => {
    expect(projBadgeHtml(null, "session-proj-badge", "mac-mini-id")).toBe("");
  });
});
