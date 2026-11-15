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

const { openChangeAccountModal, openChangeAccountForChat } = await import("../src/shared/change-account-modal.ts");

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

    const text = (id) => overlay().querySelector(`[data-acc-id="${id}"] .cam-limit-text`).textContent;
    expect(text(personal.id)).toBe("5h 42% · 7d 31%");
    expect(text(work.id)).toMatch(/^5h limit reached/);
    expect(text(credit.id)).toBe("$145.68 of $200 left");
    expect(overlay().querySelector(`[data-acc-id="${work.id}"] .cam-limit-limit`)).not.toBeNull();
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

describe("openChangeAccountForChat - limit status rows", () => {
  it("shows the status too, since it reads this machine's own account list", async () => {
    listAccounts.mockResolvedValue([personal, work]);
    getUsageMap.mockResolvedValue({
      [personal.id]: { session_pct: 10, weekly_pct: 20, session_resets_at: hoursAhead(2), weekly_resets_at: hoursAhead(90) },
    });
    const pending = openChangeAccountForChat({ currentId: null, subsCount: 0, apiCreditAllowed: true });
    await vi.waitFor(() => expect(overlay()?.querySelectorAll(".cam-limit").length).toBe(2));
    expect(overlay().querySelector(`[data-acc-id="${personal.id}"] .cam-limit-text`).textContent).toBe("5h 10% · 7d 20%");
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
