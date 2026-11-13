// @vitest-environment jsdom
//
// The usage-limit strip on an auto-frozen chat (2026-11-13, "frozen chats
// can't get unfrozen"): the chat must offer a move to another account right
// where Joe is looking, even when the daemon's in-memory rate-limit stamp is
// gone (a daemon restart, or the old result-line clear).

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/api.ts", () => ({ api: {} }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: () => {} }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: () => {} }));

const { needsFrozenLimitStrip, suggestedAccount, frozenLimitStripHtml, syncFrozenLimitStrip } = await import(
  "../src/views/sessions/frozen-limit-strip.ts"
);

const PERSONAL = { id: "acc-personal", label: "personal", colour: "#9d7dfc", icon: "user", kind: "subscription" };
const DANE = { id: "acc-dane", label: "dane", colour: "#3ecf8e", icon: "buildings", kind: "subscription" };
const API = { id: "acc-api", label: "Personal API", colour: "#f5a524", icon: "key", kind: "api_credit" };
const ACCOUNTS = [PERSONAL, API, DANE];

function chat(overrides = {}) {
  return {
    session_id: "s1",
    account_id: PERSONAL.id,
    frozen: true,
    auto_frozen: true,
    machine: null,
    ended_at: null,
    rate_limited_resets_at: null,
    rate_limited_type: null,
    ...overrides,
  };
}

describe("needsFrozenLimitStrip", () => {
  it("shows only for a usage-limit freeze", () => {
    expect(needsFrozenLimitStrip(chat(), false)).toBe(true);
    expect(needsFrozenLimitStrip(chat({ auto_frozen: false }), false)).toBe(false);
    expect(needsFrozenLimitStrip(chat({ frozen: false, auto_frozen: false }), false)).toBe(false);
    expect(needsFrozenLimitStrip(chat(), true)).toBe(false);
    expect(needsFrozenLimitStrip(chat({ machine: { id: "m1", label: "Mac" } }), false)).toBe(false);
    expect(needsFrozenLimitStrip(undefined, false)).toBe(false);
  });
});

describe("suggestedAccount", () => {
  it("never suggests the chat's own account or an API-credit account", () => {
    expect(suggestedAccount(chat(), ACCOUNTS, [])?.id).toBe(DANE.id);
  });

  it("skips an account that is blocked right now", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const blockedDane = chat({ session_id: "s2", account_id: DANE.id, frozen: false, auto_frozen: false, rate_limited_resets_at: future });
    expect(suggestedAccount(chat(), ACCOUNTS, [blockedDane])).toBeNull();
  });
});

describe("frozenLimitStripHtml", () => {
  it("offers the other plan account in one click, with no rate-limit stamp needed", () => {
    const html = frozenLimitStripHtml(chat(), ACCOUNTS, []);
    expect(html).toContain("Personal is out of usage");
    expect(html).toContain("Continue on Dane");
    expect(html).not.toContain("Personal API");
    expect(html).toContain("Change account");
  });

  it("still offers Change account when no plan account is free", () => {
    const html = frozenLimitStripHtml(chat(), [PERSONAL, API], []);
    expect(html).not.toContain("fls-move");
    expect(html).toContain("Change account");
  });
});

describe("syncFrozenLimitStrip", () => {
  it("wires the buttons and clears the strip once the chat is unfrozen", () => {
    const slot = document.createElement("div");
    const moveTo = vi.fn(() => Promise.resolve());
    const changeAccount = vi.fn();
    syncFrozenLimitStrip(slot, chat(), false, ACCOUNTS, [], { moveTo, changeAccount });
    slot.querySelector(".fls-move").click();
    expect(moveTo).toHaveBeenCalledWith(DANE.id, "dane");
    slot.querySelector(".fls-change").click();
    expect(changeAccount).toHaveBeenCalledTimes(1);

    syncFrozenLimitStrip(slot, chat({ frozen: false, auto_frozen: false }), false, ACCOUNTS, [], { moveTo, changeAccount });
    expect(slot.innerHTML).toBe("");

    // Frozen again later: it must paint again, not skip as "unchanged".
    syncFrozenLimitStrip(slot, chat(), false, ACCOUNTS, [], { moveTo, changeAccount });
    expect(slot.querySelector(".frozen-limit-strip")).not.toBeNull();
  });

  it("sends one move per click while it is in flight, and re-enables the button after a failed move", async () => {
    const slot = document.createElement("div");
    const moveTo = vi.fn(() => Promise.reject(new Error("spawn failed")));
    syncFrozenLimitStrip(slot, chat(), false, ACCOUNTS, [], { moveTo, changeAccount: () => {} });
    const btn = slot.querySelector(".fls-move");
    btn.click();
    btn.click();
    expect(moveTo).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.disabled).toBe(false);
  });

  it("keeps the button disabled when a repaint lands while a move is in flight", () => {
    const slot = document.createElement("div");
    const moveTo = vi.fn(() => new Promise(() => {}));
    const actions = { moveTo, changeAccount: () => {} };
    syncFrozenLimitStrip(slot, chat(), false, ACCOUNTS, [], actions);
    slot.querySelector(".fls-move").click();
    // A reset time arriving mid-move changes the markup, so the strip repaints.
    const future = Math.floor(Date.now() / 1000) + 3600;
    syncFrozenLimitStrip(slot, chat({ rate_limited_resets_at: future }), false, ACCOUNTS, [], actions);
    const fresh = slot.querySelector(".fls-move");
    expect(fresh.disabled).toBe(true);
    fresh.click();
    expect(moveTo).toHaveBeenCalledTimes(1);
  });
});
