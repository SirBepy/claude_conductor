// asserts: src/views/dashboard/widgets/schedule-widget.ts, src/views/dashboard/widgets/skill-charts-widget.ts
import { test, expect } from "@playwright/test";
import { mountView, invokeCalls, capture } from "./harness";

const DASH_BASE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_accounts: [],
  get_usage_map: {},
  get_auth_state_map: {},
  poll_now: null,
};

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const SCHEDULED = [
  {
    id: "item-1",
    kind: { type: "message", session_id: "s1", cwd: "C:/p/proj" },
    prompt: "nightly check",
    fire_at: inHours(2),
    recurrence: { rule: { type: "daily" } },
    status: { type: "pending" },
    created_at: inHours(-24),
    last_fired_at: null,
    last_result: null,
  },
  {
    id: "item-2",
    kind: { type: "new_chat", cwd: "C:/work/my_app", model: "m", effort: "e", account_id: null },
    prompt: "weekly review",
    fire_at: inHours(30),
    recurrence: null,
    status: { type: "pending" },
    created_at: inHours(-24),
    last_fired_at: null,
    last_result: null,
  },
  {
    id: "item-done",
    kind: { type: "message", session_id: "s1", cwd: "C:/p/proj" },
    prompt: "already ran",
    fire_at: inHours(-5),
    recurrence: null,
    status: { type: "sent" },
    created_at: inHours(-24),
    last_fired_at: inHours(-5),
    last_result: null,
  },
];

const skillEntry = (skill: string, total: number) => ({
  skill,
  invocations: { total, manual: total, skill: 0, auto: 0 },
  chats: 1,
  tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
});

test.describe("view-harness / dashboard home widgets", () => {
  test("schedule widget lists upcoming items only and 'Open calendar' pops the window", async ({ page }) => {
    await mountView(page, {
      view: "dashboard",
      invoke: {
        ...DASH_BASE,
        get_skill_usage_week: { entries: [], total_sessions: 0 },
        schedule_list: SCHEDULED,
        schedule_list_external: [],
        list_instances: [{ session_id: "s1", name: "Nightly chat", cwd: "C:/p/proj" }],
        open_schedule_window: null,
      },
    });

    const widget = page.locator('.dash-widget[data-widget-id="schedule"]');
    const rows = widget.locator(".sched-w-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Nightly chat");
    await expect(rows.nth(0).locator(".ph-repeat")).toHaveCount(1);
    await expect(rows.nth(1)).toContainText("New chat: my_app");
    await expect(widget).not.toContainText("already ran");

    await widget.getByRole("button", { name: /Open calendar/ }).click();
    await expect
      .poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "open_schedule_window"))
      .toBe(true);

    await capture(widget, "home-schedule-widget");
  });

  test("schedule widget shows an empty state with the calendar button", async ({ page }) => {
    await mountView(page, {
      view: "dashboard",
      invoke: {
        ...DASH_BASE,
        get_skill_usage_week: { entries: [], total_sessions: 0 },
        schedule_list: [],
        schedule_list_external: [],
        list_instances: [],
      },
    });
    const widget = page.locator('.dash-widget[data-widget-id="schedule"]');
    await expect(widget).toContainText("Nothing scheduled");
    await expect(widget.getByRole("button", { name: /Open calendar/ })).toBeVisible();
  });

  test("top-skills bars rank by runs and a skill name opens its detail", async ({ page }) => {
    await mountView(page, {
      view: "dashboard",
      invoke: {
        ...DASH_BASE,
        get_skill_usage_week: {
          entries: [skillEntry("commit", 7), skillEntry("test", 3), skillEntry("unused", 0)],
          total_sessions: 4,
        },
        get_skill_usage_detail: {
          skill: "commit",
          invocations: { total: 7, manual: 7, skill: 0, auto: 0 },
          events: [
            { ts: new Date().toISOString(), skill: "commit", session_id: "s", project: "p", source: "manual", tokens: {} },
            { ts: new Date().toISOString(), skill: "commit", session_id: "s", project: "p", source: "manual", tokens: {} },
          ],
        },
        schedule_list: [],
        schedule_list_external: [],
        list_instances: [],
        list_installed_skills: [],
        list_projects: [],
      },
    });

    const top = page.locator('.dash-widget[data-widget-id="skill-top"]');
    const names = top.locator(".skill-bar-name");
    await expect(names).toHaveText(["commit", "test"]);

    const runs = page.locator('.dash-widget[data-widget-id="skill-runs"]');
    await expect(runs.locator(".skill-day")).toHaveCount(7);
    // Today is the last column; the mocked detail returns 2 events for it.
    await expect(runs.locator(".skill-day").last().locator(".skill-day-count")).not.toHaveText("");

    // Home renders narrow; shoot at that width, tall enough that nothing scrolls out of the frame.
    await page.setViewportSize({ width: 560, height: 1800 });
    await page.waitForTimeout(600);
    await capture(page, "home-skill-widgets-560");

    await names.first().click();
    await expect(page.locator(".view-skill-detail h2")).toHaveText("commit");
    expect(await page.evaluate(() => (window as unknown as { skillDetailTarget?: string }).skillDetailTarget)).toBe("commit");
  });
});
