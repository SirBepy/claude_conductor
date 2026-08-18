import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression for todo 687: wireOverflowMenu's #viewMoreBtn click listener was
// never removed in its own teardown, so a same-view remount (lit-html reuses
// the button node) stacked a second listener - one click then fired both,
// opening then immediately re-closing the menu.

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  get_usage_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  poll_now: null,
  list_projects: [],
  resolve_whitelist_characters: [],
  probe_models_availability: [],
  list_accounts: [],
  list_scheduled_messages: [],
  list_pending_prompts: [],
  list_instances: [],
  get_active_sessions: [],
  get_when_done_state: { phase: "disarmed" },
};

async function mountSessions(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, { view: "sessions", invoke: BASE_INVOKE });
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

    await expect(page.locator(".view-more-menu")).toBeVisible();
    const box = await page.locator("#newSessionBtn").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });
});
