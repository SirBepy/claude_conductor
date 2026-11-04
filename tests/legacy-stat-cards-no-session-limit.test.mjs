// @vitest-environment jsdom
// The pre-onboarding fallback card pair prints a "Session (5h)" card only for a
// plan that has a 5h limit; a limit-free plan's 0% is a stand-in, not a reading.
import { describe, it, expect } from "vitest";

import { legacyStatCardsHtml } from "../src/views/dashboard/legacy-stat-cards.ts";
import { planHasNoSessionWindow } from "../src/views/dashboard/widgets/usage-charts.ts";

const future = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const record = (extra) => ({
  hour: "2026-11-04T10",
  session_pct: 0,
  weekly_pct: 36,
  session_resets_at: null,
  weekly_resets_at: future(48),
  extra_usage: null,
  ...extra,
});

describe("legacy stat cards", () => {
  it("draws only the weekly card when the plan has no 5h limit", () => {
    const html = legacyStatCardsHtml([record({ session_limited: false })]);
    expect(html).not.toContain("Session (5h)");
    expect(html).toContain("Weekly (7d)");
  });

  it("draws both cards for a plan with a 5h limit", () => {
    const html = legacyStatCardsHtml([record({ session_limited: true })]);
    expect(html).toContain("Session (5h)");
    expect(html).toContain("Weekly (7d)");
  });

  it("reads an unflagged record as limited", () => {
    expect(legacyStatCardsHtml([record({})])).toContain("Session (5h)");
  });
});

describe("planHasNoSessionWindow", () => {
  it("follows the latest record only", () => {
    expect(planHasNoSessionWindow([record({ session_limited: true }), record({ session_limited: false })])).toBe(true);
    expect(planHasNoSessionWindow([record({ session_limited: false }), record({ session_limited: true })])).toBe(false);
  });

  it("is false for an empty history or an unflagged record", () => {
    expect(planHasNoSessionWindow([])).toBe(false);
    expect(planHasNoSessionWindow([record({})])).toBe(false);
  });
});
