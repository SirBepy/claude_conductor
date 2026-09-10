// @vitest-environment jsdom

// A single-account registry is a confirmation, not a choice (todo 883): the
// new-chat account field must still show which account is in play, but stop
// offering it as something to click through.

import { describe, it, expect } from "vitest";
import {
  renderAccountFieldHtml,
  attachAccountFieldHandlers,
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

describe("renderAccountFieldHtml - exactly one account (todo 883 skip path)", () => {
  it("still names the account", () => {
    const html = renderAccountFieldHtml({ accountId: personal.id }, { accounts: [personal] });
    expect(html).toContain("Account");
    expect(html).toContain("personal");
  });

  it("renders it as a non-interactive chip: no data-acc-id, no role=button", () => {
    const html = renderAccountFieldHtml({ accountId: personal.id }, { accounts: [personal] });
    expect(html).not.toContain("data-acc-id");
    expect(html).not.toContain("role=\"button\"");
    expect(html).toContain("me-acc-static");
  });

  it("attachAccountFieldHandlers finds nothing to wire a click to", () => {
    const html = renderAccountFieldHtml({ accountId: personal.id }, { accounts: [personal] });
    const el = mount(html);
    const state = { accountId: personal.id };
    let changed = false;
    attachAccountFieldHandlers(el, state, () => { changed = true; }, () => {});
    el.querySelector(".me-acc-static")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(changed).toBe(false);
    expect(state.accountId).toBe(personal.id);
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
