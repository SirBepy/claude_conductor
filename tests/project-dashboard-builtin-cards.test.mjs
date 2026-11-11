// The dashboard's built-in card ids are kept twice: the Rust list the daemon
// validates `dashboard_builtin_set_hidden` against, and the TS list the "Show or
// hide cards" modal draws. A card in only one of them is either unhideable or
// rejected by the daemon, and neither failure shows up in a typecheck.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const { BUILTIN_CARDS } = await import("../src/views/sessions/project-dashboard/format.ts");

const rust = readFileSync(new URL("../src-tauri/src/project_dashboard/types.rs", import.meta.url), "utf8");

/** The ids inside `BUILTIN_CARDS: [&str; N] = [ ... ];`, whatever the line endings or wrapping. */
function rustIds() {
  const m = /BUILTIN_CARDS:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\]/.exec(rust);
  if (!m) throw new Error("BUILTIN_CARDS not found in types.rs");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("built-in dashboard cards", () => {
  it("are the same ids in the Rust list and the TS modal list", () => {
    expect([...rustIds()].sort()).toEqual(BUILTIN_CARDS.map((b) => b.id).sort());
  });

  it("have no id twice", () => {
    const ids = BUILTIN_CARDS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
