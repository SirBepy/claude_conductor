import { describe, it, expect } from "vitest";
import {
  formatCents,
  formatResetDate,
  apiCreditLine,
  grantRemainingFraction,
} from "../src/shared/api-credit-format.ts";

const status = (over = {}) => ({
  account_id: "acct-credit",
  max_grant_remaining_cents: 17871,
  max_grant_total_cents: 20000,
  max_grant_expires_at: "2026-11-02T00:00:00Z",
  purchased_remaining_cents: 0,
  spend_cents: 2128,
  limit_cents: 20000,
  spend_resets_at: "2026-11-01T00:00:00Z",
  fetched_at: "2026-10-26T12:00:00Z",
  blocked: false,
  block_reason: null,
  error: null,
  ...over,
});

describe("formatCents", () => {
  it("keeps cents when there are any and drops them for whole dollars", () => {
    expect(formatCents(17871)).toBe("$178.71");
    expect(formatCents(20000)).toBe("$200");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0");
  });

  it("groups thousands and signs a negative", () => {
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(-250)).toBe("-$2.50");
  });
});

describe("formatResetDate", () => {
  it("reads the UTC calendar day, whatever the viewer's zone", () => {
    expect(formatResetDate("2026-11-02T00:00:00Z")).toBe("Nov 2");
    expect(formatResetDate("2026-11-30T23:59:59Z")).toBe("Nov 30");
  });

  it("is null for nothing or garbage", () => {
    expect(formatResetDate(null)).toBeNull();
    expect(formatResetDate("not a date")).toBeNull();
  });
});

describe("apiCreditLine", () => {
  it("writes the live figures the way the settings row shows them", () => {
    const line = apiCreditLine(status());
    expect(line.summary).toBe("API credit $178.71 of $200 left, expires Nov 2 · $21.28 of $200 limit");
    expect(line.figures).toBe("$178.71 of $200 left, expires Nov 2 · $21.28 of $200 limit");
    expect(line.error).toBeNull();
    expect(line.blockReason).toBeNull();
  });

  it("leaves a part out when its figure is missing", () => {
    expect(apiCreditLine(status({ spend_cents: null })).summary).toBe("API credit $178.71 of $200 left, expires Nov 2");
    expect(apiCreditLine(status({ max_grant_remaining_cents: null })).summary).toBe("API credit $21.28 of $200 limit");
    expect(apiCreditLine(status({ max_grant_total_cents: null, max_grant_expires_at: null })).figures)
      .toBe("$178.71 left · $21.28 of $200 limit");
  });

  it("flags Connect Console for a not-connected or expired login, not for other errors", () => {
    expect(apiCreditLine(status({ error: "Console not connected" })).needsConnect).toBe(true);
    expect(apiCreditLine(status({ error: "Console login expired" })).needsConnect).toBe(true);
    expect(apiCreditLine(status({ error: "HTTP 500 from the Console" })).needsConnect).toBe(false);
  });

  it("has no figures for a status with none and keeps the error", () => {
    const line = apiCreditLine(status({
      max_grant_remaining_cents: null, max_grant_total_cents: null, max_grant_expires_at: null,
      spend_cents: null, limit_cents: null, error: "Console not connected",
    }));
    expect(line.summary).toBeNull();
    expect(line.error).toBe("Console not connected");
  });

  it("carries the block reason, with a fallback when the daemon sent none", () => {
    expect(apiCreditLine(status({ blocked: true, block_reason: "Console spend limit $200 reached" })).blockReason)
      .toBe("Console spend limit $200 reached");
    expect(apiCreditLine(status({ blocked: true, block_reason: null })).blockReason).toMatch(/paused/);
  });

  it("is empty before the first status arrives", () => {
    expect(apiCreditLine(undefined)).toEqual({
      figures: null, summary: null, left: null, total: null, resets: null, spend: null,
      error: null, needsConnect: false, blockReason: null,
    });
  });
});

describe("grantRemainingFraction", () => {
  it("is remaining over total, clamped to 0..1", () => {
    expect(grantRemainingFraction(status())).toBeCloseTo(0.89355, 4);
    expect(grantRemainingFraction(status({ max_grant_remaining_cents: 30000 }))).toBe(1);
    expect(grantRemainingFraction(status({ max_grant_remaining_cents: -5 }))).toBe(0);
  });

  it("is null without both figures or with a zero total", () => {
    expect(grantRemainingFraction(status({ max_grant_total_cents: null }))).toBeNull();
    expect(grantRemainingFraction(status({ max_grant_total_cents: 0 }))).toBeNull();
    expect(grantRemainingFraction(undefined)).toBeNull();
  });
});
