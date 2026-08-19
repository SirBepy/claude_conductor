import { expect, test } from "@playwright/test";
import { capture, mountSessionsLayout, mountView } from "./harness";

// Capture-only: these assert nothing, they write PNGs into
// .for_bepy/screenshots/<session-id>/. CC_SHOTS is the gate, not --grep, which
// never reaches the worker process (measured 2026-08-20):
//   $env:CC_SHOTS=1; pnpm exec playwright test --grep '@shot' --workers=1
const DESKTOP = { width: 1400, height: 900 };
const PHONE = { width: 390, height: 780 };

const DASHBOARD_MOCKS = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_accounts: [
    { id: "acc-1", label: "Personal", icon: "user", colour: "#8b5cf6" },
    { id: "acc-2", label: "Work", icon: "briefcase", colour: "#57b894" },
  ],
  get_usage_map: {},
  get_auth_state_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  list_instances: [],
  poll_now: null,
};

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("dashboard", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { view: "dashboard", invoke: DASHBOARD_MOCKS });
    await capture(page, "dashboard");
  });

  test("sessions desktop, preview panel docked open", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: { list_previews: [] } });
    // No scaffold header here: it would paint over the booted shell's own band.
    await mountSessionsLayout(page, { openPanel: true });
    await capture(page, "sessions-desktop-panel");
  });

  test("sessions phone pager", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page, { invoke: { list_previews: [] } });
    await mountSessionsLayout(page, { pager: true });
    await capture(page, "sessions-phone-chat");

    await page.locator('.mtab[data-target="preview"]').click();
    // The pager scroll-snaps over a frame or two, so shooting straight after the
    // click still lands on the chat page.
    await expect
      .poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".sessions-layout")!.scrollLeft))
      .toBeGreaterThan(PHONE.width / 2);
    await capture(page, "sessions-phone-preview");
  });

  test("overlay strip", async ({ page }) => {
    const now = Date.now();
    await mountView(page, {
      entry: "overlay",
      invoke: {
        list_accounts: [{ id: "acc1", label: "Fleet-3", colour: "#57b894", icon: "robot" }],
        get_usage_map: {
          acc1: {
            captured_at: new Date(now).toISOString(),
            five_hour: { utilization: 62, resets_at: new Date(now + 90 * 60_000).toISOString() },
            seven_day: { utilization: 41, resets_at: new Date(now + 4 * 24 * 3_600_000).toISOString() },
          },
        },
      },
    });
    await capture(page.locator("#ocPanel"), "overlay-strip");
  });
});
