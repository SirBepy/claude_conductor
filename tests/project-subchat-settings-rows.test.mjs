// @vitest-environment jsdom

// Project settings rows that are gone, so a revert brings none of them back unnoticed:
// "Subs changing files" (every writing sub gets its own worktree, 2026-11-12) and
// "Check a sub's work" (Joe removed it on 2026-11-13: no project used Facts only, and
// the daemon keeps its strict default). The rail view spec
// (subchat-writer-slot.view.spec.ts) asserts the rendered settings carry neither.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/api.ts", () => ({ api: {} }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
const rows = await import("../src/views/sessions/project-dashboard/project-config/rows.ts");

describe("Project settings > removed rows", () => {
  it("Subs changing files is gone: no row renders it, since every writing sub gets its own worktree", () => {
    expect(rows.renderSubchatWritersRow).toBeUndefined();
  });

  it("Check a sub's work is gone", () => {
    expect(rows.renderSubchatCheckRow).toBeUndefined();
  });

  it("the connectors switch stays", () => {
    expect(typeof rows.renderConnectorsRow).toBe("function");
  });
});
