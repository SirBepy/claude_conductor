// asserts: src/views/dashboard/dashboard.ts
import { test, expect, type Page } from "@playwright/test";
import { fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// pc-1748: the Dashboard panel beside a chat replayed its charts on every chat click and at
// random while idle. A rebuild that looks identical still restarts every CSS entrance
// animation, so these assert node identity: a node tagged before the event must still be the
// node in the page afterwards, and an update with changed data must still land.

const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const usage = (fiveHourPct: number) => ({
  captured_at: new Date().toISOString(),
  five_hour: { utilization: fiveHourPct, resets_at: future(2) },
  seven_day: { utilization: 20, resets_at: future(48) },
});

const SESSIONS = [
  sessionInstance({ busy: false, awaiting: null }),
  sessionInstance({ session_id: "s2", cwd: "C:/Projects/beta", project_id: "p2", name: "Beta chat", busy: false, awaiting: null }),
];

async function mountChatsWithDashboard(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      get_accounts_setup_prompt_state: { shouldShow: false },
      list_accounts: [{ id: "acc-1", label: "Personal", icon: "user", colour: "#8b5cf6", kind: "subscription" }],
      get_usage_map: { "acc-1": usage(40) },
      get_auth_state_map: {},
      get_skill_usage_week: { entries: [], total_sessions: 0 },
      poll_now: null,
      schedule_list: [],
      schedule_list_external: [],
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator(".sp-strip").first().waitFor();
  await page.evaluate(async () => (await import("/shared/global-panel.ts")).setGlobalPanel("dashboard"));
  await page.locator(".sp-panel .dash-acard").first().waitFor();
  // The mount settles a beat after the first paint (token history, credit watch); tag after it.
  await page.waitForTimeout(500);
}

/** Tags the dashboard's own nodes so a later rebuild shows as a node that lost its tag. */
async function tagNodes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector(".sp-panel .view-dashboard")!;
    root.querySelectorAll(".dash-acard, .dash-widgets, .dash-widget").forEach((el) => {
      (el as unknown as { __tag: boolean }).__tag = true;
    });
  });
}

async function untaggedNodes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector(".sp-panel .view-dashboard")!;
    return [...root.querySelectorAll(".dash-acard, .dash-widgets, .dash-widget")].filter(
      (el) => !(el as unknown as { __tag?: boolean }).__tag,
    ).length;
  });
}

/** Counts how often the dashboard fetched the usage map, which every rebuild does once. */
async function countUsageFetches(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as any;
    w.__usageFetches = 0;
    const tauri = w.__TAURI__;
    const passthrough = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: any) => {
      if (cmd === "get_usage_map") w.__usageFetches++;
      return passthrough(cmd, args);
    };
  });
  return () => page.evaluate(() => (window as any).__usageFetches as number);
}

test("clicking another chat leaves the open Dashboard panel's nodes alone", async ({ page }) => {
  await mountChatsWithDashboard(page);
  await tagNodes(page);
  expect(await page.locator(".sp-panel .dash-acard").count()).toBeGreaterThan(0);

  await page.locator('#sessions-list li[data-session-id="s2"]').click();
  await page.waitForTimeout(700);

  await expect(page.locator(".sp-panel .view-dashboard")).toHaveCount(1);
  expect(await untaggedNodes(page)).toBe(0);
});

test("an idle usage update with the same data does not rebuild the Dashboard", async ({ page }) => {
  await mountChatsWithDashboard(page);
  await tagNodes(page);
  const fetches = await countUsageFetches(page);

  // What the daemon's usage-updated event and the app's own refresh-dashboard-home do while idle.
  await fireEvent(page, "usage-updated", [null]);
  await page.evaluate(() => window.dispatchEvent(new Event("refresh-dashboard-home")));
  await page.waitForTimeout(700);

  // The data is re-read (that is how a change is noticed) but nothing is drawn again.
  expect(await fetches()).toBeGreaterThan(0);
  expect(await untaggedNodes(page)).toBe(0);
});

test("an idle update after the clock moved on redraws the safe-pace marker the 1s tick does not touch", async ({ page }) => {
  await mountChatsWithDashboard(page);
  const marker = page.locator(".sp-panel .dash-acard .dash-ring-safe").first();
  await expect(marker).toBeVisible();
  const before = await marker.innerText();

  // The `/N%` safe-pace label comes from the clock and is not part of the usage data: half an hour
  // on, with the same numbers, it must read differently.
  await page.evaluate(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 30 * 60_000;
  });
  await fireEvent(page, "usage-updated", [null]);
  await page.evaluate(() => window.dispatchEvent(new Event("refresh-dashboard-home")));

  await expect(async () => {
    expect(await page.locator(".sp-panel .dash-acard .dash-ring-safe").first().innerText()).not.toBe(before);
  }).toPass();
});

test("a usage update with changed numbers still updates the Dashboard", async ({ page }) => {
  await mountChatsWithDashboard(page);
  await expect(page.locator(".sp-panel .dash-acard .dash-ring-cur").first()).toHaveText("40%");

  await page.evaluate((next) => {
    const tauri = (window as any).__TAURI__;
    const passthrough = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: any) =>
      cmd === "get_usage_map" ? Promise.resolve({ "acc-1": next }) : passthrough(cmd, args);
  }, usage(65));
  await fireEvent(page, "usage-updated", [null]);

  await expect(page.locator(".sp-panel .dash-acard .dash-ring-cur").first()).toHaveText("65%");
});
