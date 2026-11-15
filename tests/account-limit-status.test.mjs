// asserts: src/shared/account-limit-status.ts
// The Change account picker's per-row status: 5h / 7d for a subscription,
// the grant balance for API credit, and "unknown" (never 0, never at-limit)
// whenever a figure is missing.

import { describe, it, expect } from "vitest";
import { subscriptionLimitStatus, apiCreditLimitStatus } from "../src/shared/account-limit-status.ts";
import { grantRemainingFraction } from "../src/shared/api-credit-format.ts";
import { creditDialHtml } from "../src/shared/usage-dial.ts";

const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

describe("subscriptionLimitStatus", () => {
  it("is unknown, not 0%, when no usage record exists yet", () => {
    expect(subscriptionLimitStatus(undefined)).toEqual({ text: "No usage data yet", tone: "unknown" });
  });

  it("is unknown when both windows are empty and have no reset time", () => {
    const s = subscriptionLimitStatus({ session_pct: null, weekly_pct: null, session_resets_at: null, weekly_resets_at: null });
    expect(s.tone).toBe("unknown");
    expect(s.text).not.toMatch(/0%/);
  });

  it("shows both windows' fill when neither is full", () => {
    const s = subscriptionLimitStatus({ session_pct: 42, weekly_pct: 31, session_resets_at: inHours(2), weekly_resets_at: inHours(90) });
    expect(s).toEqual({ text: "5h 42% · 7d 31%", tone: "ok" });
  });

  it("drops the 5h part for a plan with no 5h limit", () => {
    const s = subscriptionLimitStatus({ session_pct: null, weekly_pct: 12, session_resets_at: null, weekly_resets_at: inHours(90), session_limited: false });
    expect(s).toEqual({ text: "7d 12%", tone: "ok" });
  });

  it("names the full 5h window and when it reopens", () => {
    const s = subscriptionLimitStatus({ session_pct: 100, weekly_pct: 40, session_resets_at: inHours(2), weekly_resets_at: inHours(90) });
    expect(s.tone).toBe("limit");
    expect(s.text).toMatch(/^5h limit reached, resets in /);
  });

  it("reads a full window whose reset already passed as unknown, not as a live limit", () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const s = subscriptionLimitStatus({ session_pct: 100, weekly_pct: 100, session_resets_at: past, weekly_resets_at: past });
    expect(s.tone).toBe("unknown");
    expect(s.text).not.toMatch(/limit reached/);
  });

  it("reports the weekly limit first when both are full", () => {
    const s = subscriptionLimitStatus({ session_pct: 100, weekly_pct: 100, session_resets_at: inHours(2), weekly_resets_at: inHours(90) });
    expect(s.text).toMatch(/^7d limit reached/);
  });
});

describe("apiCreditLimitStatus", () => {
  const base = {
    account_id: "c", max_grant_remaining_cents: null, max_grant_total_cents: null, max_grant_expires_at: null,
    purchased_remaining_cents: null, spend_cents: null, limit_cents: null, spend_resets_at: null,
    fetched_at: "2026-11-15T00:00:00Z", blocked: false, block_reason: null, error: null,
  };

  it("is unknown when the Console returned nothing", () => {
    expect(apiCreditLimitStatus(undefined)).toEqual({ text: "Balance unknown", tone: "unknown" });
    expect(apiCreditLimitStatus(base).tone).toBe("unknown");
  });

  it("points at Connect Console when the session expired", () => {
    const s = apiCreditLimitStatus({ ...base, error: "Console session expired" });
    expect(s.tone).toBe("unknown");
    expect(s.text).toMatch(/Connect Console/);
  });

  it("shows what is left of the grant", () => {
    const s = apiCreditLimitStatus({ ...base, max_grant_remaining_cents: 14568, max_grant_total_cents: 20000 });
    expect(s).toEqual({ text: "$145.68 of $200 left", tone: "ok" });
  });

  it("a spent-out grant reads $0 left, not unknown", () => {
    const s = apiCreditLimitStatus({ ...base, max_grant_remaining_cents: 0, max_grant_total_cents: 20000 });
    expect(s.text).toBe("$0 of $200 left");
  });

  it("shows the pause reason when new turns are refused", () => {
    const s = apiCreditLimitStatus({ ...base, blocked: true, block_reason: "Spend limit reached" });
    expect(s).toEqual({ text: "Spend limit reached", tone: "limit" });
  });

  it("purchased credit with no Max grant figure stays unknown", () => {
    const s = apiCreditLimitStatus({ ...base, purchased_remaining_cents: 5000 });
    expect(s.tone).toBe("unknown");
  });
});

describe("creditDialHtml", () => {
  const settings = {};
  const acc = { icon: "key", colour: "#10b981" };

  it("draws a dashed track and a question mark for an unknown balance", () => {
    expect(grantRemainingFraction(undefined)).toBeNull();
    const html = creditDialHtml(null, acc, settings, false, 0.6);
    expect(html).toContain("stroke-dasharray=\"3 3\"");
    expect(html).toContain("oc-ic-unknown");
    expect(html).not.toContain("stroke-linecap");
  });

  it("fills the outer ring by the remaining share and leaves the inner ring empty", () => {
    const html = creditDialHtml(0.5, acc, settings, false, 0.6);
    const c = 2 * Math.PI * 19;
    expect(html).toContain(`stroke-dasharray="${(0.5 * c).toFixed(2)} ${c.toFixed(2)}"`);
    expect(html).not.toContain("oc-ic-unknown");
    // outer track + outer arc + inner track only: one round-capped arc.
    expect(html.match(/stroke-linecap/g)).toHaveLength(1);
  });

  it("a spent-out grant draws an empty arc, not the unknown state", () => {
    const html = creditDialHtml(0, acc, settings, false, 0.6);
    expect(html).not.toContain("oc-dial-unknown");
    expect(html).toContain(`stroke-dasharray="0.00 ${(2 * Math.PI * 19).toFixed(2)}"`);
  });
});
