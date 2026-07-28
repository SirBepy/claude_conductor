import { describe, it, expect } from "vitest";
import { buildOverlayRow, buildOverlayRows } from "../src/views/overlay/overlay-logic.ts";

const personal = { id: "acct-personal", label: "Personal", colour: "#9d7dfc", icon: "user" };
const work = { id: "acct-work", label: "Work", colour: "#f5a623", icon: "briefcase" };

const NOW = new Date("2026-04-20T10:00:00Z").getTime();

describe("buildOverlayRow", () => {
  it("marks an account with no usage entry as no-data, all metrics null", () => {
    const row = buildOverlayRow(personal, undefined, NOW);
    expect(row.hasData).toBe(false);
    expect(row.session).toEqual({ pct: null, safePct: null, resetIso: null });
    expect(row.weekly).toEqual({ pct: null, safePct: null, resetIso: null });
    expect(row.id).toBe("acct-personal");
    expect(row.colour).toBe("#9d7dfc");
  });

  it("computes session/weekly pct + safe-pace from a usage record", () => {
    const usage = {
      session_pct: 42,
      weekly_pct: 31,
      session_resets_at: "2026-04-20T15:00:00Z", // +5h, matches the 5h window exactly
      weekly_resets_at: "2026-04-27T10:00:00Z", // +7d, matches the 7d window exactly
    };
    const row = buildOverlayRow(work, usage, NOW);
    expect(row.hasData).toBe(true);
    expect(row.session.pct).toBe(42);
    expect(row.session.safePct).toBe(0); // window just started
    expect(row.weekly.pct).toBe(31);
    expect(row.weekly.safePct).toBe(0);
    expect(row.session.resetIso).toBe("2026-04-20T15:00:00Z");
    expect(row.weekly.resetIso).toBe("2026-04-27T10:00:00Z");
  });

  it("falls back to a synthetic +1h weekly reset when the API omits it (matches account-selector.ts)", () => {
    const usage = {
      session_pct: 10,
      weekly_pct: 5,
      session_resets_at: null,
      weekly_resets_at: null,
    };
    const row = buildOverlayRow(personal, usage, NOW);
    // No exception, and a safe pct still comes out (near 0% since the
    // fallback reset is ~now + 1h against a 7-day window).
    expect(row.weekly.safePct).not.toBeNull();
    expect(row.session.safePct).toBeNull(); // no fallback for session
    // resetIso stays null (raw) even though safePct got a fallback anchor -
    // the fallback is only for the safe-pace maths, never a display value.
    expect(row.weekly.resetIso).toBeNull();
    expect(row.session.resetIso).toBeNull();
  });
});

describe("buildOverlayRows", () => {
  it("maps every account in registry order, independent of usage-map key order", () => {
    const usageByAccount = {
      "acct-work": { session_pct: 78, weekly_pct: 55, session_resets_at: null, weekly_resets_at: null },
      "acct-personal": { session_pct: 42, weekly_pct: 31, session_resets_at: null, weekly_resets_at: null },
    };
    const rows = buildOverlayRows([personal, work], usageByAccount, NOW);
    expect(rows.map((r) => r.id)).toEqual(["acct-personal", "acct-work"]);
    expect(rows[0].session.pct).toBe(42);
    expect(rows[1].session.pct).toBe(78);
  });

  it("returns a no-data row for an account absent from the usage map", () => {
    const rows = buildOverlayRows([personal], {}, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].hasData).toBe(false);
  });

  it("returns an empty array for an empty registry", () => {
    expect(buildOverlayRows([], {}, NOW)).toEqual([]);
  });
});
