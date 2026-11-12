import { expect, test } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, capture, mountView, sessionInstance } from "./harness";

// Capture-only proof shots for todo 569 (v0.2.59 shipped unverified visually):
// the <=768px rate-limit-banner kebab.
const PHONE = { width: 390, height: 780 };

// The transport hands JSON numbers back for this bigint-typed field, so the
// fixture matches the wire shape rather than the generated type.
const resetsAtSecs = (msFromNow: number): bigint =>
  Math.floor((Date.now() + msFromNow) / 1000) as unknown as bigint;

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");
  test.use({ deviceScaleFactor: 2 });

  test("mobile rate-limit banner collapses to one kebab", async ({ page }) => {
    await page.setViewportSize(PHONE);
    const blocked = sessionInstance({
      session_id: "s-blocked", name: "Blocked chat", account_id: "acc-1",
      rate_limited_resets_at: resetsAtSecs(2 * 3_600_000), rate_limited_type: "five_hour",
    });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_accounts: [
          { id: "acc-1", label: "personal", icon: "user", colour: "#8b5cf6" },
          { id: "acc-2", label: "work", icon: "briefcase", colour: "#57b894" },
        ],
        list_instances: [blocked], get_active_sessions: [blocked],
      },
    });

    const banner = page.locator(".rate-limit-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Personal hit its 5-hour limit");

    const kebab = banner.locator(".rlb-kebab");
    await expect(kebab).toHaveCount(1);
    await expect(kebab).toBeVisible();
    for (const cls of [".rlb-move", ".rlb-schedule", ".rlb-minimize"]) {
      await expect(banner.locator(cls)).toBeHidden();
    }
    await capture(banner, "rate-limit-kebab-mobile");

    await kebab.click();
    const menu = page.locator(".session-more-menu");
    await expect(menu).toBeVisible();
    const items = menu.locator(".smore-item");
    await expect(items).toHaveText(["Continue on Work", "View in Schedule", "Minimize"]);

    for (let i = 0; i < 3; i++) {
      const box = (await items.nth(i).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
      expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
    }
    await capture(page, "rate-limit-kebab-menu-open");
  });
});
