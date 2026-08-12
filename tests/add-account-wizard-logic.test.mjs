import { describe, it, expect } from "vitest";
import {
  ICON_POOL,
  COLOUR_POOL,
  LOGIN_TIMEOUT_MS,
  pickAvailableIcon,
  prefillLabel,
  tierLabel,
  formatElapsed,
  isLoginTimedOut,
  describeLoginOutcome,
  formatTokenExpiry,
  formatRefreshExpiry,
  buildIdentitySurface,
} from "../src/views/settings/subviews/accounts/wizard-logic.ts";

describe("pickAvailableIcon", () => {
  it("returns the first pool entry when nothing is used", () => {
    expect(pickAvailableIcon(ICON_POOL, [])).toBe(ICON_POOL[0]);
  });

  it("skips icons already used by other accounts", () => {
    const used = [ICON_POOL[0], ICON_POOL[1]];
    expect(pickAvailableIcon(ICON_POOL, used)).toBe(ICON_POOL[2]);
  });

  it("wraps around the pool from a non-zero startIndex", () => {
    const startIndex = ICON_POOL.length - 1;
    const used = [];
    expect(pickAvailableIcon(ICON_POOL, used, startIndex)).toBe(ICON_POOL[startIndex]);
  });

  it("falls back to the startIndex entry when every icon is taken", () => {
    expect(pickAvailableIcon(ICON_POOL, [...ICON_POOL], 3)).toBe(ICON_POOL[3]);
  });

  it("returns empty string for an empty pool", () => {
    expect(pickAvailableIcon([], [])).toBe("");
  });
});

describe("prefillLabel", () => {
  it("prefers the organization name when present", () => {
    expect(
      prefillLabel({ organizationName: "Fibo Studio", emailAddress: "joe@fibo.hr" }),
    ).toBe("Fibo Studio");
  });

  it("falls back to a title-cased email local part when org name is absent", () => {
    expect(prefillLabel({ organizationName: null, emailAddress: "joe.muzic@example.com" })).toBe(
      "Joe Muzic",
    );
  });

  it("falls back to the raw email when the local part yields nothing usable", () => {
    expect(prefillLabel({ organizationName: "", emailAddress: "@example.com" })).toBe(
      "@example.com",
    );
  });

  it("ignores a whitespace-only organization name", () => {
    expect(prefillLabel({ organizationName: "   ", emailAddress: "a_b-c@x.com" })).toBe("A B C");
  });
});

describe("tierLabel", () => {
  it("maps known tiers to friendly labels", () => {
    expect(tierLabel("claude_max")).toBe("Max");
    expect(tierLabel("claude_pro")).toBe("Pro");
    expect(tierLabel("claude_team")).toBe("Team");
  });

  it("title-cases an unknown tier, stripping a claude_ prefix", () => {
    expect(tierLabel("claude_enterprise_plus")).toBe("Enterprise Plus");
  });

  it("falls back to a generic label when absent", () => {
    expect(tierLabel(null)).toBe("Unknown plan");
    expect(tierLabel(undefined)).toBe("Unknown plan");
    expect(tierLabel("")).toBe("Unknown plan");
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute durations", () => {
    expect(formatElapsed(5000)).toBe("0:05");
  });

  it("formats minutes and seconds with zero-padding", () => {
    expect(formatElapsed(83000)).toBe("1:23");
  });

  it("clamps negative input to 0:00", () => {
    expect(formatElapsed(-500)).toBe("0:00");
  });
});

describe("isLoginTimedOut", () => {
  it("is false right up to the timeout", () => {
    expect(isLoginTimedOut(LOGIN_TIMEOUT_MS - 1)).toBe(false);
  });

  it("is true at and past the timeout", () => {
    expect(isLoginTimedOut(LOGIN_TIMEOUT_MS)).toBe(true);
    expect(isLoginTimedOut(LOGIN_TIMEOUT_MS + 1000)).toBe(true);
  });
});

describe("describeLoginOutcome", () => {
  it("maps Pending to kind pending, defaulting misdirected to null", () => {
    expect(
      describeLoginOutcome({ status: "Pending", misdirected: null, credentials_no_profile: false }),
    ).toEqual({
      kind: "pending",
      misdirected: null,
      credentialsNoProfile: false,
    });
  });

  it("passes a misdirected-login hint through on Pending", () => {
    expect(
      describeLoginOutcome({
        status: "Pending",
        misdirected: "your terminal's default profile (~/.claude)",
        credentials_no_profile: false,
      }),
    ).toEqual({
      kind: "pending",
      misdirected: "your terminal's default profile (~/.claude)",
      credentialsNoProfile: false,
    });
  });

  it("flags credentials-without-profile on Pending", () => {
    expect(
      describeLoginOutcome({ status: "Pending", misdirected: null, credentials_no_profile: true }),
    ).toEqual({
      kind: "pending",
      misdirected: null,
      credentialsNoProfile: true,
    });
  });

  it("maps Ready to kind ready, passing the identity through", () => {
    const identity = { emailAddress: "a@x.com", organizationUuid: "org-1" };
    expect(describeLoginOutcome({ status: "Ready", identity })).toEqual({
      kind: "ready",
      identity,
    });
  });

  it("maps Mismatch to a plain-English message naming both emails", () => {
    const result = describeLoginOutcome({
      status: "Mismatch",
      existing_email: "old@x.com",
      new_email: "new@x.com",
    });
    expect(result.kind).toBe("mismatch");
    expect(result.message).toContain("old@x.com");
    expect(result.message).toContain("new@x.com");
  });

  it("maps Duplicate to a message naming the existing label", () => {
    const result = describeLoginOutcome({ status: "Duplicate", existing_label: "Work" });
    expect(result.kind).toBe("duplicate");
    expect(result.message).toContain("Work");
  });
});

describe("pool sanity", () => {
  it("ICON_POOL and COLOUR_POOL are non-empty and de-duplicated", () => {
    expect(ICON_POOL.length).toBeGreaterThan(0);
    expect(new Set(ICON_POOL).size).toBe(ICON_POOL.length);
    expect(COLOUR_POOL.length).toBeGreaterThan(0);
    expect(new Set(COLOUR_POOL).size).toBe(COLOUR_POOL.length);
  });
});

// Multi-account milestone 07: Settings > Accounts identity surface.
describe("formatTokenExpiry", () => {
  const now = new Date("2026-07-07T00:00:00Z").getTime();

  it("reports unknown expiry when absent", () => {
    expect(formatTokenExpiry(null, now)).toBe("Token expiry unknown");
    expect(formatTokenExpiry(undefined, now)).toBe("Token expiry unknown");
  });

  it("reports expired when in the past", () => {
    expect(formatTokenExpiry(now - 1000, now)).toBe("Token expired");
  });

  it("reports days remaining", () => {
    expect(formatTokenExpiry(now + 3 * 86_400_000, now)).toBe("Token expires in 3d");
  });

  it("reports hours remaining under a day", () => {
    expect(formatTokenExpiry(now + 5 * 3_600_000, now)).toBe("Token expires in 5h");
  });

  it("reports minutes remaining under an hour", () => {
    expect(formatTokenExpiry(now + 30 * 60_000, now)).toBe("Token expires in 30m");
  });

  it("accepts a bigint (ts-rs's mapping for the Rust i64 field)", () => {
    expect(formatTokenExpiry(BigInt(now + 3 * 86_400_000), now)).toBe("Token expires in 3d");
  });
});

// ai_todo 560: refresh-token window countdown (Settings > Accounts).
describe("formatRefreshExpiry", () => {
  const now = new Date("2026-07-07T00:00:00Z").getTime();

  it("reports unknown window when absent", () => {
    expect(formatRefreshExpiry(null, now)).toBe("Re-login window unknown");
    expect(formatRefreshExpiry(undefined, now)).toBe("Re-login window unknown");
  });

  it("reports required now when in the past", () => {
    expect(formatRefreshExpiry(now - 1000, now)).toBe("Re-login required now");
  });

  it("reports days remaining", () => {
    expect(formatRefreshExpiry(now + 27 * 86_400_000, now)).toBe("Re-login needed in 27d");
  });

  it("reports hours remaining under a day", () => {
    expect(formatRefreshExpiry(now + 5 * 3_600_000, now)).toBe("Re-login needed in 5h");
  });

  it("accepts a bigint (ts-rs's mapping for the Rust i64 field)", () => {
    expect(formatRefreshExpiry(BigInt(now + 27 * 86_400_000), now)).toBe("Re-login needed in 27d");
  });
});

describe("buildIdentitySurface", () => {
  const account = { email: "registered@x.com", subscription_tier: "claude_pro" };

  it("falls back to the registry email/tier when identity is null (still loading)", () => {
    const view = buildIdentitySurface(account, null);
    expect(view.loggedInAsEmail).toBeNull();
    expect(view.tierLabel).toBe("Pro");
    expect(view.tokenExpiryLabel).toBe("Token expiry unknown");
    expect(view.refreshExpiryLabel).toBe("Re-login window unknown");
    expect(view.hasCookie).toBe(false);
    expect(view.warningMessage).toBeNull();
  });

  it("prefers the live oauthAccount email/tier over the registry record", () => {
    const identity = {
      oauthAccount: { emailAddress: "live@x.com", organizationUuid: "org-1", organizationType: "claude_max" },
      tokenExpiresAt: null,
      hasCookie: true,
      drift: false,
      driftMessage: null,
    };
    const view = buildIdentitySurface(account, identity);
    expect(view.loggedInAsEmail).toBe("live@x.com");
    expect(view.tierLabel).toBe("Max");
    expect(view.hasCookie).toBe(true);
    expect(view.warningMessage).toBeNull();
  });

  it("surfaces the drift message as a warning when drift is true", () => {
    const identity = {
      oauthAccount: { emailAddress: "wrong@x.com", organizationUuid: "org-2" },
      tokenExpiresAt: null,
      hasCookie: false,
      drift: true,
      driftMessage: "now logged in as wrong@x.com",
    };
    const view = buildIdentitySurface(account, identity);
    expect(view.warningMessage).toBe("now logged in as wrong@x.com");
  });

  it("falls back to a generic warning when drift is true but no message came through", () => {
    const identity = {
      oauthAccount: null,
      tokenExpiresAt: null,
      hasCookie: false,
      drift: true,
      driftMessage: null,
    };
    const view = buildIdentitySurface(account, identity);
    expect(view.warningMessage).toBe("Identity mismatch - re-verify this account.");
  });
});
