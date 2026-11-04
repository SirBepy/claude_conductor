// asserts: src/views/dashboard/legacy-stat-cards.ts, src/views/dashboard/widgets/usage-charts.ts, src/views/dashboard/widgets/usage-chart-view.ts, src/views/dashboard/widgets/usage-bars-view.ts
import { expect, test, type Page } from "@playwright/test";
import { mountView } from "./harness";

// A plan with no 5h limit reports a flat 0% 5h window (`five_hour_limited: false`).
// The dashboard must not plot, bar or card that stand-in as if it were a reading.

const now = Date.now();
const weekly = new Date(now + 3 * 86_400_000).toISOString();

function history(limited: boolean) {
  return [5, 4, 3, 2, 1].map((h, i) => ({
    captured_at: new Date(now - h * 3_600_000).toISOString(),
    five_hour: limited
      ? { utilization: 10 + i * 8, resets_at: new Date(now + 2 * 3_600_000).toISOString() }
      : { utilization: 0, resets_at: null },
    five_hour_limited: limited,
    seven_day: { utilization: 5 + i * 3, resets_at: weekly },
  }));
}

async function mount(page: Page, limited: boolean) {
  await mountView(page, {
    view: "dashboard",
    invoke: {
      get_settings: { theme: "void", dashboardWidgets: [
        ...["session-chart", "session-bars", "weekly-chart"].map((id) => ({ id, enabled: true })),
        ...["schedule", "skill-top", "skill-runs"].map((id) => ({ id, enabled: false })),
      ] },
      get_accounts_setup_prompt_state: { shouldShow: false },
      // No accounts: the dashboard shows the legacy two-card fallback.
      list_accounts: [],
      get_usage_map: {},
      get_auth_state_map: {},
      get_skill_usage_week: { entries: [], total_sessions: 0 },
      list_instances: [],
      get_history: history(limited),
      poll_now: null,
      schedule_list: [],
      schedule_list_external: [],
    },
  });
}

const widget = (page: Page, id: string) => page.locator(`.dash-widget[data-widget-id='${id}']`);

test("a plan with no 5h limit shows no 5h chart, bars or legacy session card", async ({ page }) => {
  await mount(page, false);

  // The weekly chart still draws, so the page has finished mounting its widgets.
  await expect(widget(page, "weekly-chart").locator("svg[data-w]")).toBeAttached();

  for (const id of ["session-chart", "session-bars"]) {
    const w = widget(page, id);
    await expect(w.locator(".v-empty-title")).toHaveText("No 5h limit on this plan");
  }
  await expect(widget(page, "session-chart").locator("svg[data-w]")).toHaveCount(0);
  await expect(widget(page, "session-bars").locator(".project-bars")).toHaveCount(0);

  await expect(page.locator(".stat-cards")).toContainText("Weekly (7d)");
  await expect(page.locator(".stat-cards")).not.toContainText("Session (5h)");
});

test("a plan with a 5h limit renders the session chart and legacy card as before", async ({ page }) => {
  await mount(page, true);

  await expect(widget(page, "session-chart").locator("svg[data-w]")).toBeAttached();
  await expect(widget(page, "session-chart")).not.toContainText("No 5h limit on this plan");
  await expect(widget(page, "session-bars").locator(".dash-widget-body > *").first()).toBeAttached();
  await expect(widget(page, "session-bars")).not.toContainText("No 5h limit on this plan");
  await expect(page.locator(".stat-cards")).toContainText("Session (5h)");
  await expect(page.locator(".stat-cards")).toContainText("Weekly (7d)");
});
