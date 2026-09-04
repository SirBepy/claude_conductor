import { describe, it, expect } from "vitest";
import {
  DEFAULT_ROWS, MAX_ROWS, isToolChip, chipToolName, isKnownChip, STATIC_CHIPS,
} from "../src/views/sessions/statusline-catalog.ts";
import { migrateLegacyFields } from "../src/views/sessions/session-statusbar-helpers.ts";

describe("statusline catalog", () => {
  it("DEFAULT_ROWS is one row within the cap", () => {
    expect(DEFAULT_ROWS.length).toBe(1);
    expect(DEFAULT_ROWS.length).toBeLessThanOrEqual(MAX_ROWS);
  });
  it("every DEFAULT_ROWS chip is known", () => {
    for (const row of DEFAULT_ROWS) for (const c of row) expect(isKnownChip(c)).toBe(true);
  });
  it("tool chip helpers round-trip", () => {
    expect(isToolChip("tool:Read")).toBe(true);
    expect(isToolChip("model")).toBe(false);
    expect(chipToolName("tool:Read")).toBe("Read");
  });
  it("context variants both exist", () => {
    expect(STATIC_CHIPS.context_pct).toBeTruthy();
    expect(STATIC_CHIPS.context_tokens).toBeTruthy();
  });
});

describe("legacy migration", () => {
  it("puts enabled fields on row 1 and visible tools on row 2", () => {
    const rows = migrateLegacyFields(
      ["model", "branch", "context", "messages"], // legacy statuslineFields (legacy "context" => context_pct)
      ["AskUserQuestion", "TodoWrite"],            // legacy tallyHiddenTools
    );
    expect(rows[0]).toEqual(["model", "branch", "context_pct", "messages"]);
    expect(rows[1]).toContain("tool:Read");
    expect(rows[1]).not.toContain("tool:AskUserQuestion");
    expect(rows[1]).not.toContain("tool:TodoWrite");
  });
  it("drops unknown legacy fields", () => {
    const rows = migrateLegacyFields(["model", "bogus"], []);
    expect(rows[0]).toEqual(["model"]);
  });
});
