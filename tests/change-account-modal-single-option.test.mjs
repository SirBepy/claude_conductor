// @vitest-environment jsdom

// A single-account registry is a confirmation, not a choice (todo 883): the
// "Change account" modal must still name the account, but stop offering it
// as something to click through.

import { describe, it, expect, vi, afterEach } from "vitest";

const { listAccounts } = vi.hoisted(() => ({ listAccounts: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({ api: { listAccounts: (...a) => listAccounts(...a) } }));

const { renderAccountListBodyHtml, openChangeAccountModal } = await import(
  "../src/shared/change-account-modal.ts"
);

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

// Red->green regression. The todo-883 static chip above is deliberately inert -
// no data-acc-id, so no click handler, no number badge, no
// registerSelectableOptions entry. That is right for a "Change account"
// display, but the history "Continue this chat" gate and the manual-takeover
// gate both bail on `if (!accountId) return`, so for them the same modal was
// an unclosable dead end: with one account there was nothing to click, Enter
// did nothing, and the only exits (Escape, the X) resolve null. Continuing a
// chat from history was impossible for anyone with a single account.
describe("openChangeAccountModal - autoPickSole (the gate callers)", () => {
  const overlay = () => document.querySelector(".cc-modal-overlay");

  afterEach(() => {
    document.querySelectorAll(".cc-modal-overlay").forEach((el) => el.remove());
    listAccounts.mockReset();
  });

  it("returns the sole account without ever opening a modal", async () => {
    listAccounts.mockResolvedValue([personal]);
    const picked = await openChangeAccountModal({
      currentId: null,
      title: "Continue as which account?",
      autoPickSole: true,
    });
    expect(picked).toBe(personal.id);
    expect(overlay()).toBeNull();
  });

  it("still opens the picker when there is a real choice to make", async () => {
    listAccounts.mockResolvedValue([personal, work]);
    const pending = openChangeAccountModal({ currentId: null, autoPickSole: true });
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    overlay().querySelector(`[data-acc-id="${work.id}"]`).click();
    expect(await pending).toBe(work.id);
  });

  it("still opens with zero accounts, so the empty-registry message is seen", async () => {
    listAccounts.mockResolvedValue([]);
    const pending = openChangeAccountModal({ currentId: null, autoPickSole: true });
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    expect(overlay().textContent).toContain("No Claude accounts configured yet");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBeNull();
  });

  it("leaves the opt-out callers on the static confirmation", async () => {
    listAccounts.mockResolvedValue([personal]);
    const pending = openChangeAccountModal({ currentId: personal.id, title: "Change account" });
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    expect(overlay().querySelector(".cam-acc-static")).not.toBeNull();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBeNull();
  });
});
