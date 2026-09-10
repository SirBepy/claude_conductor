// Account chip should never spend pixels naming the only account there is
// (todo 883) - the picker below is what actually forces a real choice; this
// chip is purely informational, so it's the first thing to go quiet.

import { describe, it, expect, beforeEach } from "vitest";
import { renderChip } from "../src/views/sessions/statusbar-chips.ts";
import { setCachedAccounts } from "../src/shared/accounts-cache.ts";

const personal = { id: "acct-personal", label: "personal", icon: "user", colour: "#9d7dfc" };
const work = { id: "acct-work", label: "work", icon: "briefcase", colour: "#f5a623" };

function ctx(accountId) {
  return {
    accountId,
    hasAccountClick: true,
    animatedKeys: new Set(),
  };
}

describe("account chip - single-option skip (todo 883)", () => {
  beforeEach(() => setCachedAccounts([]));

  it("renders nothing with zero cached accounts", () => {
    setCachedAccounts([]);
    expect(renderChip("account", ctx(null))).toBe("");
  });

  it("renders nothing with exactly one cached account, even though it's assigned", () => {
    setCachedAccounts([personal]);
    expect(renderChip("account", ctx(personal.id))).toBe("");
  });

  it("still renders the chip once a second account exists", () => {
    setCachedAccounts([personal, work]);
    const html = renderChip("account", ctx(personal.id));
    expect(html).toContain("sb-account");
    expect(html).toContain("Personal");
  });

  it("goes quiet again if the second account is later removed", () => {
    setCachedAccounts([personal, work]);
    expect(renderChip("account", ctx(personal.id))).not.toBe("");
    setCachedAccounts([personal]);
    expect(renderChip("account", ctx(personal.id))).toBe("");
  });
});
