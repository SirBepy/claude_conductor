import { expect, test } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, capture, mountSessionsList, mountView, sessionInstance } from "./harness";

// Capture-only proof shots for todo 569 (v0.2.59 shipped unverified visually):
// the close_failed warning dot, and the <=768px rate-limit-banner kebab.
const DESKTOP = { width: 1400, height: 900 };
const PHONE = { width: 390, height: 780 };

const CLOSE_FAILED_TIP = "Close did not confirm - the chat may still be open";

// The transport hands JSON numbers back for this bigint-typed field, so the
// fixture matches the wire shape rather than the generated type.
const resetsAtSecs = (msFromNow: number): bigint =>
  Math.floor((Date.now() + msFromNow) / 1000) as unknown as bigint;

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");
  test.use({ deviceScaleFactor: 2 });

  test("close_failed warning dot", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountSessionsList(page, [
      sessionInstance({
        session_id: "s-failed", name: "Closed chat", cwd: "C:/Projects/alpha",
        awaiting: "close_failed",
      }),
      sessionInstance({
        session_id: "s-idle", name: "Idle chat", cwd: "C:/Projects/beta",
        pid: 101, awaiting: "done",
      }),
    ]);
    await expect.poll(() => page.locator(".sessions-list .row-entering").count()).toBe(0);

    const failedRow = page.locator("li[data-session-id='s-failed']");
    const avatar = failedRow.locator(".session-avatar");
    await expect(avatar).toHaveClass(/st-close-failed/);
    await expect(avatar).toHaveAttribute("title", CLOSE_FAILED_TIP);
    await expect(failedRow.locator(".avatar-status-dot")).toHaveClass(/st-close-failed/);
    await expect(page.locator("li[data-session-id='s-idle'] .avatar-status-dot")).toHaveClass(/st-your-turn/);

    console.log(`[tooltip] ${await avatar.getAttribute("title")}`);
    await capture(failedRow.locator(".session-avatar-wrap"), "close-failed-dot");
    await capture(page.locator("#sessions-list"), "close-failed-vs-idle-list");
  });

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
