// Reviewed 2026-11-09: #viewMoreBtn renders on the phone only, so this spec mounts the phone transport and asserts the dropdown again.
import { test, expect } from "@playwright/test";
import { mountViewPhone, SESSIONS_BASE_INVOKE } from "./harness";

// Regression for todo 687: wireOverflowMenu's #viewMoreBtn click listener was
// never removed in its own teardown, so a same-view remount (lit-html reuses
// the button node) stacked a second listener - one click then fired both,
// opening then immediately re-closing the menu. The button is phone-only now
// (the desktop opens the command palette with Ctrl+Shift+P), so this mounts the
// phone transport.

const BASE_INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [],
  get_active_sessions: [],
  get_when_done_state: { phase: "disarmed" },
};

async function mountSessions(page: import("@playwright/test").Page): Promise<void> {
  await mountViewPhone(page, { view: "sessions", invoke: BASE_INVOKE });
  await page.locator("#viewMoreBtn").waitFor();
}

test.describe("view-harness / overflow menu remount", () => {
  test("stays openable after a same-view remount", async ({ page }) => {
    await mountSessions(page);

    // Force a second mount of the same view, exactly as router.ts's
    // navigateTo does on a same-view navigation - the exposed global lets the
    // test trigger it without a second full page load.
    await page.evaluate(() => (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("sessions"));
    await page.locator("#viewMoreBtn").waitFor();

    await page.locator("#viewMoreBtn").click();

    await expect(page.locator(".session-more-menu")).toBeVisible();
  });

  // Leaving Chats and coming back rebuilds .view-header from scratch, while
  // mobile-header-merge.ts's remembered "home" still pointed at the old,
  // detached one - so the fresh ⋮ was filed away into nothing.
  test("survives a round trip through another view", async ({ page }) => {
    await mountSessions(page);

    const navigateTo = (n: string) =>
      page.evaluate((name) => (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo(name), n);
    await navigateTo("dashboard");
    await navigateTo("sessions");

    await expect(page.locator("#viewMoreBtn")).toBeVisible();
    await page.locator("#viewMoreBtn").click();
    await expect(page.locator(".session-more-menu")).toBeVisible();
  });
});
