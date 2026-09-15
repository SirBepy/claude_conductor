// @vitest-environment jsdom

// A single-account registry is a confirmation, not a choice (todo 883): the
// "Change account" modal must still name the account, but stop offering it
// as something to click through.

import { describe, it, expect } from "vitest";
import { renderAccountListBodyHtml } from "../src/shared/change-account-modal.ts";

const personal = { id: "acct-personal", label: "personal", icon: "user", colour: "#9d7dfc" };
const work = { id: "acct-work", label: "work", icon: "briefcase", colour: "#f5a623" };

function mount(html) {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("renderAccountListBodyHtml - zero accounts", () => {
  it("shows the empty-registry message, no chip row", () => {
    const html = renderAccountListBodyHtml([], null);
    expect(html).toContain("No Claude accounts configured yet");
    expect(html).not.toContain("account-chip");
  });
});

describe("renderAccountListBodyHtml - exactly one account (todo 883 skip path)", () => {
  it("still names the account", () => {
    const html = renderAccountListBodyHtml([personal], personal.id);
    expect(html).toContain("personal");
  });

  it("renders it as a non-interactive chip: no data-acc-id, no role=button", () => {
    const html = renderAccountListBodyHtml([personal], personal.id);
    expect(html).not.toContain("data-acc-id");
    expect(html).not.toContain("role=\"button\"");
    expect(html).toContain("cam-acc-static");
  });

  it("leaves nothing for the modal's [data-acc-id] chip query to find", () => {
    const html = renderAccountListBodyHtml([personal], personal.id);
    const el = mount(html);
    expect(el.querySelectorAll(".cam-account-list .account-chip[data-acc-id]").length).toBe(0);
  });
});

describe("renderAccountListBodyHtml - two or more accounts (unchanged)", () => {
  it("renders one clickable chip per account, each with data-acc-id", () => {
    const html = renderAccountListBodyHtml([personal, work], personal.id);
    expect(html).toContain(`data-acc-id="${personal.id}"`);
    expect(html).toContain(`data-acc-id="${work.id}"`);
  });

  it("marks the current account selected", () => {
    const html = renderAccountListBodyHtml([personal, work], work.id);
    const el = mount(html);
    const workChip = el.querySelector(`[data-acc-id="${work.id}"]`);
    const personalChip = el.querySelector(`[data-acc-id="${personal.id}"]`);
    expect(workChip.className).toContain("sel");
    expect(personalChip.className).not.toContain("sel");
  });
});
