import { describe, it, expect } from "vitest";
import { buildOverlayRow, buildOverlayRows, buildOverlayEntries } from "../src/views/overlay/overlay-logic.ts";

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

describe("buildOverlayRow - 5h window states", () => {
  const weekly = { weekly_pct: 8, weekly_resets_at: "2026-04-27T10:00:00Z" };

  it("reads an idle 5h window (0% and no reset time) as no value, so it draws a dash", () => {
    const row = buildOverlayRow(work, { ...weekly, session_pct: 0, session_resets_at: null }, NOW);
    expect(row.session.pct).toBeNull();
    expect(row.sessionLimited).toBe(true);
  });

  it("keeps a real 0% on a running window (it carries a reset time)", () => {
    const row = buildOverlayRow(work, { ...weekly, session_pct: 0, session_resets_at: "2026-04-20T15:00:00Z" }, NOW);
    expect(row.session.pct).toBe(0);
  });

  it("flags a plan with no 5h limit so the dial draws one ring", () => {
    const row = buildOverlayRow(work, { ...weekly, session_pct: 0, session_resets_at: null, session_limited: false }, NOW);
    expect(row.sessionLimited).toBe(false);
  });

  it("treats a record without the flag as limited", () => {
    const row = buildOverlayRow(work, { ...weekly, session_pct: 5, session_resets_at: null }, NOW);
    expect(row.sessionLimited).toBe(true);
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

// An API-credit account has no claude.ai usage: its dial would be empty, so
// the sessions header dials (fed by buildOverlayRows) never draw it. The
// overlay window draws it from the Console figures instead (buildOverlayEntries
// below).
describe("buildOverlayRows - API-credit accounts", () => {
  const credit = { id: "acct-credit", label: "API credit", colour: "#10b981", icon: "key", kind: "api_credit" };

  it("leaves an API-credit account out of the rows", () => {
    const rows = buildOverlayRows([personal, credit, work], {}, NOW);
    expect(rows.map((r) => r.id)).toEqual(["acct-personal", "acct-work"]);
  });

  it("returns no rows when the registry holds only the API-credit account", () => {
    expect(buildOverlayRows([credit], {}, NOW)).toEqual([]);
  });

  it("keeps an account that carries kind: subscription", () => {
    const sub = { ...personal, kind: "subscription" };
    expect(buildOverlayRows([sub], {}, NOW).map((r) => r.id)).toEqual(["acct-personal"]);
  });
});

// The overlay window (unlike the phone header) draws an API-credit account as
// a dial of its own, from the Console figures.
describe("buildOverlayEntries", () => {
  const credit = { id: "acct-credit", label: "API credit", colour: "#10b981", icon: "user", kind: "api_credit" };
  const status = (over = {}) => ({
    account_id: "acct-credit", max_grant_remaining_cents: 5000, max_grant_total_cents: 20000, max_grant_expires_at: null,
    purchased_remaining_cents: 0, spend_cents: 0, limit_cents: 20000, spend_resets_at: null, fetched_at: "x",
    blocked: false, block_reason: null, error: null, ...over,
  });

  it("keeps registry order with the credit account between the plan accounts", () => {
    const e = buildOverlayEntries([personal, credit, work], {}, { "acct-credit": status() }, NOW);
    expect(e.map((x) => `${x.kind}:${x.row.id}`)).toEqual(["plan:acct-personal", "credit:acct-credit", "plan:acct-work"]);
  });

  it("maps the grant share and balance, with the key glyph whatever icon the account carries", () => {
    const [e] = buildOverlayEntries([credit], {}, { "acct-credit": status() }, NOW);
    expect(e.row.remaining).toBe(0.25);
    expect(e.row.left).toBe("$50");
    expect(e.row.icon).toBe("key");
  });

  it("an unknown balance is null, never 0 or 1", () => {
    const none = buildOverlayEntries([credit], {}, {}, NOW)[0].row;
    expect(none.remaining).toBeNull();
    expect(none.left).toBeNull();
    const noFigure = buildOverlayEntries([credit], {}, { "acct-credit": status({ max_grant_remaining_cents: null, max_grant_total_cents: null }) }, NOW)[0].row;
    expect(noFigure.remaining).toBeNull();
  });

  it("a spent-out grant is 0, not unknown", () => {
    const [e] = buildOverlayEntries([credit], {}, { "acct-credit": status({ max_grant_remaining_cents: 0 }) }, NOW);
    expect(e.row.remaining).toBe(0);
    expect(e.row.left).toBe("$0");
  });

  it("a purchased-only credit (no Max grant figures) reads unknown, not as a drained grant", () => {
    const [e] = buildOverlayEntries([credit], {}, { "acct-credit": status({ max_grant_remaining_cents: null, max_grant_total_cents: null, purchased_remaining_cents: 4000 }) }, NOW);
    expect(e.row.remaining).toBeNull();
  });

  it("leaves subscription rows exactly as buildOverlayRows draws them", () => {
    const usage = { "acct-work": { session_pct: 78, weekly_pct: 55, session_resets_at: null, weekly_resets_at: null } };
    const [plan] = buildOverlayEntries([work], usage, {}, NOW);
    expect(plan.row).toEqual(buildOverlayRows([work], usage, NOW)[0]);
  });
});

describe("creditCellHtml (taskbar widget cell)", () => {
  it("draws the credit dial with the balance on hover and routes the click as an API-credit refresh", async () => {
    const { creditCellHtml } = await import("../src/shared/usage-dial.ts");
    const row = { id: "acct-credit", label: "API credit", colour: "#10b981", icon: "key", remaining: 0.5, left: "$100" };
    const html = creditCellHtml(row, {}, true);
    expect(html).toContain('data-acc-id="acct-credit"');
    expect(html).toContain('data-kind="api_credit"');
    expect(html).toContain("<b>$100</b>");
    expect(html).toContain("oc-disc");
    expect(html).not.toContain("oc-reset-pop");
  });

  it("an unknown balance reads ? with an unknown caption, on a dashed dial", async () => {
    const { creditCellHtml } = await import("../src/shared/usage-dial.ts");
    const html = creditCellHtml({ id: "a", label: "API credit", colour: "#10b981", icon: "key", remaining: null, left: null }, {}, false);
    expect(html).toContain("oc-dial-unknown");
    expect(html).toContain("<b>?</b>");
    expect(html).toContain("unknown");
  });
});
