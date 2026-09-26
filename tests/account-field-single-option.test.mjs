// @vitest-environment jsdom

// A single-account registry is not a choice at all (todo 883, tightened by
// Joe 2026-09-26): the new-chat account field renders nothing, rather than a
// non-interactive chip naming the only possible answer.

import { describe, it, expect } from "vitest";
import {
  renderAccountFieldHtml,
  attachAccountFieldHandlers,
  accountPickIncomplete,
} from "../src/views/sessions/account-field.ts";

const personal = { id: "acct-personal", label: "personal", icon: "user", colour: "#9d7dfc" };
const work = { id: "acct-work", label: "work", icon: "briefcase", colour: "#f5a623" };

function mount(html) {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("renderAccountFieldHtml - zero accounts", () => {
  it("shows the empty-registry message, no chip row", () => {
    const html = renderAccountFieldHtml({ accountId: null }, { accounts: [] });
    expect(html).toContain("No Claude accounts yet");
    expect(html).not.toContain("account-chip");
  });
});

describe("renderAccountFieldHtml - exactly one account (hidden entirely)", () => {
  it("renders nothing at all: no label, no chip, no field wrapper", () => {
    const html = renderAccountFieldHtml({ accountId: personal.id }, { accounts: [personal] });
    expect(html).toBe("");
  });

  it("leaves the modal with no account DOM for a handler to find", () => {
    const html = renderAccountFieldHtml({ accountId: personal.id }, { accounts: [personal] });
    const el = mount(html);
    const state = { accountId: personal.id };
    let changed = false;
    attachAccountFieldHandlers(el, state, () => { changed = true; }, () => {});
    expect(el.querySelector(".account-chip")).toBeNull();
    expect(changed).toBe(false);
    expect(state.accountId).toBe(personal.id);
  });

  it("does not gate Start session: the sole account is still the picked one", () => {
    expect(accountPickIncomplete({ accountId: personal.id }, [personal])).toBe(false);
  });
});

describe("renderAccountFieldHtml - two or more accounts (unchanged)", () => {
  it("renders one clickable chip per account, each with data-acc-id", () => {
    const html = renderAccountFieldHtml({ accountId: personal.id }, { accounts: [personal, work] });
    expect(html).toContain(`data-acc-id="${personal.id}"`);
    expect(html).toContain(`data-acc-id="${work.id}"`);
  });

  it("clicking a different chip still switches the picked account", () => {
    const html = renderAccountFieldHtml({ accountId: personal.id }, { accounts: [personal, work] });
    const el = mount(html);
    const state = { accountId: personal.id };
    let changed = false;
    attachAccountFieldHandlers(el, state, () => { changed = true; }, () => {});
    el.querySelector(`[data-acc-id="${work.id}"]`).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(changed).toBe(true);
    expect(state.accountId).toBe(work.id);
  });
});
