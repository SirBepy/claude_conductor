// @vitest-environment jsdom

// The API-credit account kind in the three places the frontend draws it: the
// new-chat account field (chip, never preselected), the dashboard meter line,
// and the live status watcher both of them read.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getApiCreditStatus: vi.fn(), onApiCreditStatusChanged: vi.fn() },
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));

const { renderAccountFieldHtml, accountPickIncomplete } = await import("../src/views/sessions/account-field.ts");
const { apiCreditMeterHtml } = await import("../src/views/dashboard/api-credit-meter.ts");
const { watchApiCreditStatus } = await import("../src/shared/api-credit-watch.ts");
const { accountIconBadgeHtml } = await import("../src/shared/account-chip.ts");

const sub = { id: "acct-sub", label: "Personal", icon: "user", colour: "#9d7dfc", kind: "subscription" };
const credit = { id: "acct-credit", label: "API credit", icon: "user", colour: "#10b981", kind: "api_credit" };

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

describe("account badge", () => {
  it("draws a key for an API-credit account whatever icon it stores", () => {
    expect(accountIconBadgeHtml(credit)).toContain("ph-key");
    expect(accountIconBadgeHtml(credit)).not.toContain("ph-user");
    expect(accountIconBadgeHtml(sub)).toContain("ph-user");
  });
});

describe("new-chat account field", () => {
  it("shows a chip for the API-credit account beside a subscription one, unselected", () => {
    const html = renderAccountFieldHtml({ accountId: "acct-sub" }, { accounts: [sub, credit] });
    expect(html).toContain('data-acc-id="acct-credit"');
    expect(html).toContain("ph-key");
    expect(html).toContain("monthly API credit");
    const chips = [...html.matchAll(/<span class="account-chip( sel)?"[^>]*data-acc-id="([^"]+)"/g)];
    expect(chips.map((m) => [m[2], !!m[1]])).toEqual([["acct-sub", true], ["acct-credit", false]]);
  });

  it("renders nothing for a lone subscription account but a chip for a lone API-credit one", () => {
    expect(renderAccountFieldHtml({ accountId: "acct-sub" }, { accounts: [sub] })).toBe("");
    const lone = renderAccountFieldHtml({ accountId: null }, { accounts: [credit] });
    expect(lone).toContain('data-acc-id="acct-credit"');
    expect(lone).not.toContain(" sel");
  });

  it("keeps Start gated until the API-credit chip is clicked", () => {
    expect(accountPickIncomplete({ accountId: null }, [credit])).toBe(true);
    expect(accountPickIncomplete({ accountId: "acct-credit" }, [credit])).toBe(false);
  });
});

describe("dashboard meter", () => {
  it("is empty without an API-credit account", () => {
    expect(apiCreditMeterHtml([sub], {})).toBe("");
  });

  it("draws one line per API-credit account with the figures and a fill", () => {
    const html = apiCreditMeterHtml([sub, credit], { "acct-credit": status() });
    expect(html.match(/class="dash-credit"/g)).toHaveLength(1);
    expect(html).toContain("API credit");
    expect(html).toContain("$178.71 of $200 left, resets Nov 2");
    expect(html).toContain("$21.28 of $200 limit");
    expect(html).toContain("width:89.4%");
  });

  it("says so before the first figures arrive", () => {
    expect(apiCreditMeterHtml([credit], {})).toContain("No figures yet");
  });

  it("shows the error as a link to Settings, with the Connect Console hint when that is the fix", () => {
    const html = apiCreditMeterHtml([credit], {
      "acct-credit": status({
        max_grant_remaining_cents: null, max_grant_total_cents: null, max_grant_expires_at: null,
        spend_cents: null, limit_cents: null, error: "Console not connected",
      }),
    });
    expect(html).toContain("dash-credit-link");
    expect(html).toContain("Console not connected - Connect Console");
    expect(html).not.toContain("dash-credit-bar");
  });

  it("shows the block reason in the warning style", () => {
    const html = apiCreditMeterHtml([credit], {
      "acct-credit": status({ blocked: true, block_reason: "Console spend limit $200 reached" }),
    });
    expect(html).toContain("dash-credit-warn");
    expect(html).toContain("Console spend limit $200 reached");
  });

  it("escapes a label", () => {
    const html = apiCreditMeterHtml([{ ...credit, label: "<b>x</b>" }], {});
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("watchApiCreditStatus", () => {
  let emit;
  const unlisten = vi.fn();

  beforeEach(() => {
    unlisten.mockReset();
    apiMock.getApiCreditStatus.mockReset();
    apiMock.onApiCreditStatusChanged.mockReset().mockImplementation((cb) => { emit = cb; return unlisten; });
  });

  it("emits the first read, then folds each event in", async () => {
    apiMock.getApiCreditStatus.mockResolvedValue({ "acct-credit": status() });
    const seen = [];
    watchApiCreditStatus((m) => seen.push(m));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)["acct-credit"].spend_cents).toBe(2128);

    emit({ account_id: "acct-credit", status: status({ spend_cents: 5000 }) });
    expect(seen.at(-1)["acct-credit"].spend_cents).toBe(5000);
  });

  it("lets an event that beat the first read win over that read's copy", async () => {
    let resolveRead;
    apiMock.getApiCreditStatus.mockReturnValue(new Promise((r) => { resolveRead = r; }));
    const seen = [];
    watchApiCreditStatus((m) => seen.push(m));
    emit({ account_id: "acct-credit", status: status({ spend_cents: 9000 }) });
    resolveRead({ "acct-credit": status({ spend_cents: 100 }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)["acct-credit"].spend_cents).toBe(9000);
  });

  it("stops emitting and unlistens once disposed", async () => {
    apiMock.getApiCreditStatus.mockResolvedValue({});
    const seen = [];
    const dispose = watchApiCreditStatus((m) => seen.push(m));
    dispose();
    emit({ account_id: "acct-credit", status: status() });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
