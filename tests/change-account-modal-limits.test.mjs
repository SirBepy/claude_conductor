// @vitest-environment jsdom
// asserts: src/shared/change-account-modal.ts

// The Change account picker shows each account's status and 5h / 7d (or grant)
// figures once they arrive, without delaying the picker itself and without
// disturbing click or number-key selection.

import { describe, it, expect, vi, afterEach } from "vitest";

const { listAccounts, getUsageMap, getApiCreditStatus } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  getUsageMap: vi.fn(),
  getApiCreditStatus: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    listAccounts: (...a) => listAccounts(...a),
    getUsageMap: (...a) => getUsageMap(...a),
    getApiCreditStatus: (...a) => getApiCreditStatus(...a),
  },
}));

const { openChangeAccountModal, openChangeAccountForChat, limitSlotHtml } = await import("../src/shared/change-account-modal.ts");

const personal = { id: "acct-personal", label: "personal", icon: "user", colour: "#9d7dfc" };
const work = { id: "acct-work", label: "work", icon: "briefcase", colour: "#f5a623" };
const credit = { id: "acct-credit", label: "API credit", icon: "user", colour: "#10b981", kind: "api_credit" };

const overlay = () => document.querySelector(".cc-modal-overlay");
const hoursAhead = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

afterEach(() => {
  document.querySelectorAll(".cc-modal-overlay").forEach((el) => el.remove());
  listAccounts.mockReset();
  getUsageMap.mockReset();
  getApiCreditStatus.mockReset();
});

describe("openChangeAccountModal - limit status rows", () => {
  it("fills each row's status after the figures arrive and keeps click selection", async () => {
    listAccounts.mockResolvedValue([personal, work, credit]);
    getUsageMap.mockResolvedValue({
      [personal.id]: { session_pct: 42, weekly_pct: 31, session_resets_at: hoursAhead(2), weekly_resets_at: hoursAhead(90) },
      [work.id]: { session_pct: 100, weekly_pct: 60, session_resets_at: hoursAhead(1), weekly_resets_at: hoursAhead(90) },
    });
    getApiCreditStatus.mockResolvedValue({
      [credit.id]: {
        account_id: credit.id, max_grant_remaining_cents: 14568, max_grant_total_cents: 20000, max_grant_expires_at: null,
        purchased_remaining_cents: null, spend_cents: null, limit_cents: null, spend_resets_at: null,
        fetched_at: "2026-11-15T00:00:00Z", blocked: false, block_reason: null, error: null,
      },
    });
    const pending = openChangeAccountModal({ currentId: null });
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    await vi.waitFor(() => expect(overlay().querySelectorAll(".cam-limit").length).toBe(3));

    const text = (id) => overlay().querySelector(`[data-acc-id="${id}"] .cam-limit-text`)?.textContent;
    expect(text(personal.id)).toBe("5h 42% 7d 31%");
    expect(text(credit.id)).toBe("$145.68 of $200 left");
    // A limited account shows a flag at rest instead of the hover figures.
    const flag = overlay().querySelector(`[data-acc-id="${work.id}"] .cam-flag`);
    expect(flag.querySelector(".cam-pill").textContent).toBe("5h limit");
    expect(flag.querySelector(".cam-back").textContent).toMatch(/^back in (\d+h )?\d+m$/);
    expect(text(work.id)).toBeUndefined();
    expect(overlay().querySelector(`[data-acc-id="${work.id}"] .cam-limit-limit`)).not.toBeNull();
    // Nothing else carries a flag, and no row is labelled with its billing kind.
    expect(overlay().querySelectorAll(".cam-flag").length).toBe(1);
    expect(overlay().querySelector(".cam-credit-hint")).toBeNull();
    // The number-key hints are still there for all three rows.
    expect(overlay().querySelectorAll(".modal-option-badge").length).toBe(3);

    overlay().querySelector(`[data-acc-id="${work.id}"]`).click();
    expect(await pending).toBe(work.id);
  });

  it("opens with no status at all when the figures cannot be read, never a wrong one", async () => {
    listAccounts.mockResolvedValue([personal, work]);
    getUsageMap.mockRejectedValue(new Error("daemon busy"));
    const pending = openChangeAccountModal({ currentId: null });
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    await vi.waitFor(() => expect(getUsageMap).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(overlay().querySelectorAll(".cam-limit").length).toBe(0);
    overlay().querySelector(`[data-acc-id="${personal.id}"]`).click();
    expect(await pending).toBe(personal.id);
  });

  it("shows an honest unknown for an account with no usage record yet", async () => {
    listAccounts.mockResolvedValue([personal, work]);
    getUsageMap.mockResolvedValue({});
    const pending = openChangeAccountModal({ currentId: null });
    await vi.waitFor(() => expect(overlay().querySelectorAll(".cam-limit").length).toBe(2));
    const slot = overlay().querySelector(`[data-acc-id="${personal.id}"] .cam-limit`);
    expect(slot.className).toContain("cam-limit-unknown");
    expect(slot.textContent).toContain("No usage data yet");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBeNull();
  });

  it("gives a peer machine's account list no status, since its ids are not this machine's", async () => {
    getUsageMap.mockResolvedValue({});
    const pending = openChangeAccountModal({ currentId: null, accounts: [personal, work] });
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(getUsageMap).not.toHaveBeenCalled();
    expect(overlay().querySelectorAll(".cam-limit").length).toBe(0);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBeNull();
  });
});

describe("limitSlotHtml - the trailing status of one row", () => {
  const base = {
    account_id: credit.id, max_grant_remaining_cents: null, max_grant_total_cents: null, max_grant_expires_at: null,
    purchased_remaining_cents: null, spend_cents: null, limit_cents: null, spend_resets_at: null,
    fetched_at: "2026-11-15T00:00:00Z", blocked: false, block_reason: null, error: null,
  };
  const slot = (a, data) => {
    const el = document.createElement("div");
    el.innerHTML = limitSlotHtml(a, data);
    return el;
  };

  it("is empty until the figures arrive", () => {
    expect(limitSlotHtml(personal, null)).toBe("");
  });

  it("an Endpoint account shows its provider's figures with no dial, and Usage unknown without any", () => {
    const kimi = { id: "acct-kimi", label: "Kimi", icon: "moon", colour: "#4f8cff", kind: "endpoint" };
    const read = { account_id: kimi.id, fetched_at: "x", windows: [], balances: [{ currency: "USD", amount: 12.4 }], spend: null, available: true, error: null, source: "deepseek" };
    const known = slot(kimi, { usage: {}, credit: {}, provider: { usage: { [kimi.id]: read }, tokens: {} } });
    expect(known.querySelector(".cam-limit-provider .cam-limit-text").textContent).toBe("$12.40 left");
    expect(known.querySelector(".oc-dial")).toBeNull();
    const unknown = slot(kimi, { usage: {}, credit: {}, provider: { usage: {}, tokens: {} } });
    expect(unknown.querySelector(".cam-limit-unknown .cam-limit-text").textContent).toBe("Usage unknown");
  });

  it("draws an unknown balance as the question-mark dial with 'Balance unknown' for hover", () => {
    const el = slot(credit, { usage: {}, credit: { [credit.id]: base } });
    expect(el.querySelector(".oc-dial-unknown .oc-ic-unknown").textContent).toBe("?");
    expect(el.querySelector(".cam-limit-text").textContent).toBe("Balance unknown");
    expect(el.querySelector(".cam-flag")).toBeNull();
  });

  it("flags a paused API-credit account with its reason and no countdown", () => {
    const el = slot(credit, { usage: {}, credit: { [credit.id]: { ...base, blocked: true, block_reason: "Spend limit reached" } } });
    expect(el.querySelector(".cam-pill").textContent).toBe("Spend limit reached");
    expect(el.querySelector(".cam-back")).toBeNull();
    expect(el.querySelector(".cam-limit-text")).toBeNull();
  });

  it("tags the API-credit slot (the CSS hides its empty inner track) and keeps both rings on a subscription", () => {
    const usage = { [personal.id]: { session_pct: 10, weekly_pct: 20, session_resets_at: hoursAhead(2), weekly_resets_at: hoursAhead(90) } };
    const sub = slot(personal, { usage, credit: {} });
    const cr = slot(credit, { usage: {}, credit: { [credit.id]: { ...base, max_grant_remaining_cents: 5000, max_grant_total_cents: 20000 } } });
    expect(sub.querySelectorAll("svg circle[r='19']").length).toBeGreaterThan(0);
    expect(sub.querySelectorAll("svg circle[r='12']").length).toBeGreaterThan(0);
    expect(cr.querySelector(".cam-limit-credit")).not.toBeNull();
    expect(sub.querySelector(".cam-limit-credit")).toBeNull();
  });

  it("flags the weekly limit as 7d", () => {
    const usage = { [work.id]: { session_pct: 20, weekly_pct: 100, session_resets_at: hoursAhead(2), weekly_resets_at: hoursAhead(30) } };
    expect(slot(work, { usage, credit: {} }).querySelector(".cam-pill").textContent).toBe("7d limit");
  });
});

describe("openChangeAccountForChat - limit status rows", () => {
  it("shows the status too, since it reads this machine's own account list", async () => {
    listAccounts.mockResolvedValue([personal, work]);
    getUsageMap.mockResolvedValue({
      [personal.id]: { session_pct: 10, weekly_pct: 20, session_resets_at: hoursAhead(2), weekly_resets_at: hoursAhead(90) },
    });
    const pending = openChangeAccountForChat({ currentId: null, subsCount: 0, apiCreditAllowed: true });
    await vi.waitFor(() => expect(overlay()?.querySelectorAll(".cam-limit").length).toBe(2));
    expect(overlay().querySelector(`[data-acc-id="${personal.id}"] .cam-limit-text`).textContent).toBe("5h 10% 7d 20%");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBeNull();
  });

  it("gives a caller-supplied (peer) list no status", async () => {
    const pending = openChangeAccountForChat({ currentId: null, subsCount: 0, apiCreditAllowed: true, accounts: [personal, work] });
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(overlay().querySelectorAll(".cam-limit").length).toBe(0);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBeNull();
  });
});
