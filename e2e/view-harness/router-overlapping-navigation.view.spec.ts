// asserts: src/router.ts, src/views/sessions/sessions.ts, src/views/sessions/sessions-teardown.ts, src/views/sessions/split-panels/split.ts, src/views/dashboard/dashboard.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The dashboard keeps one mounted instance in module state (mountedContainer,
// widgetTeardowns, aiPollTimer), so two chat splits that both answer the
// Dashboard panel would fight over it. That needs the router to tear the old
// Chats view (and its split) down before the next one renders, and never to
// run two renders at once, because a view only hands back its teardown after
// its async render settles.

/** The real Chats view with a chat open, and a counter of Dashboard mounts:
 *  every renderDashboard asks for the setup prompt state exactly once. */
async function mountChats(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance({ busy: false, awaiting: null })],
      get_active_sessions: [sessionInstance({ busy: false, awaiting: null })],
      get_accounts_setup_prompt_state: { shouldShow: false },
      list_accounts: [],
      get_usage_map: {},
      get_auth_state_map: {},
      get_skill_usage_week: { entries: [], total_sessions: 0 },
      poll_now: null,
      schedule_list: [],
      schedule_list_external: [],
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator(".sp-strip").first().waitFor();

  await page.evaluate(() => {
    document.body.classList.add("chats-window-mode");
    const w = window as any;
    w.__dashMounts = 0;
    const tauri = w.__TAURI__;
    const passthrough = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: any) => {
      if (cmd === "get_accounts_setup_prompt_state") w.__dashMounts++;
      return passthrough(cmd, args);
    };
  });
}

async function openDashboardPanelAndCountMounts(page: Page): Promise<number> {
  await page.evaluate(async () => (await import("/shared/global-panel.ts")).setGlobalPanel("dashboard"));
  await expect(page.locator(".sp-panel .view-dashboard")).toHaveCount(1);
  // A split left behind by an earlier mount would mount its own copy a beat later.
  await page.waitForTimeout(600);
  return page.evaluate(() => (window as any).__dashMounts);
}

test("leaving Chats and coming back leaves one split, so the Dashboard panel mounts once", async ({ page }) => {
  await mountChats(page);
  await page.evaluate(async () => {
    const nav = (window as any).navigateTo as (n: string) => Promise<void>;
    await nav("sessions");
    await nav("sessions");
  });
  expect(await openDashboardPanelAndCountMounts(page)).toBe(1);
});

test("two navigations to Chats issued together leave one split, so the Dashboard panel mounts once", async ({ page }) => {
  await mountChats(page);
  // A double click on Chats, or a tray route landing as the view mounts.
  await page.evaluate(async () => {
    const nav = (window as any).navigateTo as (n: string) => Promise<void>;
    await Promise.all([nav("sessions"), nav("sessions")]);
  });
  expect(await openDashboardPanelAndCountMounts(page)).toBe(1);
});
