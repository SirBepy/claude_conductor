// Reviewed 2026-11-23: Endpoint accounts and the Models & providers page do not change what this spec asserts.
import { test, expect } from "@playwright/test";
import { capture, mountView } from "./harness";

// asserts: src/views/overlay/overlay.ts, src/views/overlay/overlay-logic.ts, src/shared/usage-dial.ts

// The taskbar widget (overlay window) draws an API-credit account as a dial of
// its own beside the subscription dials (pc-1749).

const base = { config_dir: "", chrome_profile_dir: "", email: "", org_uuid: "", subscription_tier: "", created_at: "", fleet_eligible: false };
const PERSONAL = { ...base, id: "acc-personal", label: "Personal", colour: "#8b5cf6", icon: "user", kind: "subscription" };
const WORK = { ...base, id: "acc-work", label: "Work", colour: "#f5a623", icon: "briefcase", kind: "subscription" };
const CREDIT = { ...base, id: "acc-credit", label: "API credit", colour: "#10b981", icon: "user", kind: "api_credit" };
const CREDIT_B = { ...base, id: "acc-credit-b", label: "Spare credit", colour: "#38bdf8", icon: "user", kind: "api_credit" };

const status = (id: string, over: Record<string, unknown> = {}) => ({
  account_id: id,
  max_grant_remaining_cents: 17871, max_grant_total_cents: 20000, max_grant_expires_at: "2026-11-30T00:00:00Z",
  purchased_remaining_cents: 0, spend_cents: 2128, limit_cents: 20000, spend_resets_at: "2026-12-01T00:00:00Z",
  fetched_at: "2026-11-15T12:00:00Z", blocked: false, block_reason: null, error: null, ...over,
});

function usage(now: number, five: number, seven: number) {
  return {
    captured_at: new Date(now).toISOString(),
    five_hour: { utilization: five, resets_at: new Date(now + 3 * 3_600_000).toISOString() },
    seven_day: { utilization: seven, resets_at: new Date(now + 4 * 24 * 3_600_000).toISOString() },
  };
}

test.describe("view-harness / overlay API-credit dials", () => {
  test("a credit account gets a dial beside the plan dials; an unknown balance reads ?, not a fill", async ({ page }) => {
    const now = Date.now();
    await mountView(page, {
      entry: "overlay",
      invoke: {
        list_accounts: [PERSONAL, CREDIT, WORK, CREDIT_B],
        get_usage_map: { "acc-personal": usage(now, 42, 31), "acc-work": usage(now, 78, 55) },
        get_api_credit_status: {
          "acc-credit": status("acc-credit"),
          // The Console returned nothing for this one yet.
          "acc-credit-b": status("acc-credit-b", { max_grant_remaining_cents: null, max_grant_total_cents: null, spend_cents: null, limit_cents: null }),
        },
      },
    });

    await expect(page.locator(".oc-cell")).toHaveCount(4);
    // Registry order, credit accounts included.
    await expect(page.locator(".oc-cell").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset["accId"]))).resolves.toEqual([
      "acc-personal", "acc-credit", "acc-work", "acc-credit-b",
    ]);
    const known = page.locator(".oc-cell[data-acc-id='acc-credit']");
    await expect(known).toHaveAttribute("data-kind", "api_credit");
    await expect(known.locator(".oc-dial-unknown")).toHaveCount(0);
    await expect(known.locator(".oc-ic-glyph.ph-key")).toHaveCount(1);
    const unknown = page.locator(".oc-cell[data-acc-id='acc-credit-b']");
    await expect(unknown.locator(".oc-dial-unknown")).toHaveCount(1);
    await expect(unknown.locator(".oc-ic-unknown")).toHaveText("?");

    await capture(page.locator("#ocPanel"), "pc-1749-overlay-four-dials");
    await known.hover();
    await expect(known.locator(".oc-info")).toContainText("$178.71");
    await expect(known.locator(".oc-info")).toContainText("left");
    await capture(page.locator("#ocPanel"), "pc-1749-overlay-credit-hover");
    await unknown.hover();
    await expect(unknown.locator(".oc-info")).toContainText("unknown");
  });

  test("a credit-only registry still draws its dial", async ({ page }) => {
    await mountView(page, {
      entry: "overlay",
      invoke: { list_accounts: [CREDIT], get_usage_map: {}, get_api_credit_status: { "acc-credit": status("acc-credit") } },
    });
    await expect(page.locator(".oc-cell[data-acc-id='acc-credit']")).toBeAttached();
    await expect(page.locator(".oc-empty")).toHaveCount(0);
  });

  test("a subscription-only registry never asks for the Console figures", async ({ page }) => {
    await mountView(page, {
      entry: "overlay",
      invoke: { list_accounts: [PERSONAL], get_usage_map: {} },
    });
    await expect(page.locator(".oc-cell")).toHaveCount(1);
    // get_api_credit_status is unmocked here: asking would reject loudly.
  });

  test("clicking a credit dial re-reads the Console, not the claude.ai usage", async ({ page }) => {
    await mountView(page, {
      entry: "overlay",
      invoke: {
        list_accounts: [PERSONAL, CREDIT],
        get_usage_map: {},
        get_api_credit_status: { "acc-credit": status("acc-credit") },
        refresh_api_credit_status: status("acc-credit"),
        poll_now: null,
      },
    });
    const cell = page.locator(".oc-cell[data-acc-id='acc-credit']");
    await expect(cell).toBeAttached();
    const box = (await cell.boundingBox())!;
    // The panel is one drag surface: a press with no movement is a click.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(async () => (await page.evaluate(() => (window as unknown as { __ccInvokeCalls: { cmd: string }[] }).__ccInvokeCalls)).map((c) => c.cmd))
      .toContain("refresh_api_credit_status");
    const cmds = (await page.evaluate(() => (window as unknown as { __ccInvokeCalls: { cmd: string }[] }).__ccInvokeCalls)).map((c) => c.cmd);
    expect(cmds).not.toContain("poll_now");
  });
});
