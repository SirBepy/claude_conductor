// asserts: src/views/dashboard/dashboard.css, src/views/dashboard/account-selector.ts
import { expect, test, type Page } from "@playwright/test";
import { mountView } from "./harness";

// An account card holds two 84px rings, so two cards only share a row when the
// dashboard's own content box is wide enough for both. The container is the dashboard
// body, not the window: the side panel is ~400px wide inside a 1280px window.

const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const snap = (five: number, seven: number) => ({
  captured_at: new Date().toISOString(),
  five_hour: { utilization: five, resets_at: future(2) },
  seven_day: { utilization: seven, resets_at: future(48) },
});

const INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_accounts: [
    { id: "acc-1", label: "Personal", icon: "user", colour: "#8b5cf6" },
    { id: "acc-2", label: "Work", icon: "user", colour: "#f59e0b" },
  ],
  get_usage_map: { "acc-1": snap(40, 20), "acc-2": snap(15, 60) },
  get_auth_state_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  list_instances: [],
  poll_now: null,
  schedule_list: [],
  schedule_list_external: [],
};

async function cards(page: Page) {
  await page.locator(".dash-acard .dash-ring").first().waitFor();
  return page.locator(".dash-acard").evaluateAll((els) =>
    els.map((el) => {
      const c = el.getBoundingClientRect();
      const rings = [...el.querySelectorAll(".dash-ring")].map((r) => r.getBoundingClientRect());
      return {
        left: c.left, top: c.top, right: c.right,
        ringOverflow: Math.max(...rings.map((r) => r.right - c.right)),
      };
    }),
  );
}

test("in a 400px container the account cards stack one per row and no ring leaves its card", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await mountView(page, { view: "dashboard", invoke: INVOKE });
  const list = await cards(page);
  const a = list[0]!;
  const b = list[1]!;
  expect(b.top).toBeGreaterThan(a.top);
  expect(Math.abs(a.left - b.left)).toBeLessThanOrEqual(1);
  expect(a.ringOverflow).toBeLessThanOrEqual(0);
  expect(b.ringOverflow).toBeLessThanOrEqual(0);
});

test("in a 900px container two cards still share a row", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await mountView(page, { view: "dashboard", invoke: INVOKE });
  const list = await cards(page);
  const a = list[0]!;
  const b = list[1]!;
  expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);
  expect(b.left).toBeGreaterThan(a.right);
  expect(a.ringOverflow).toBeLessThanOrEqual(0);
  expect(b.ringOverflow).toBeLessThanOrEqual(0);
});
