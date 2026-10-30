import { expect, test } from "@playwright/test";
import { capture, mountView } from "./harness";
import type { ScheduledItem } from "../../src/types/ipc.generated";

// asserts: src/views/schedule/schedule-render.ts, src/views/schedule/schedule-format.ts, src/views/schedule/schedule-recurrence.ts

// The pre-fire guard on the Schedule panel: a guarded row says it is
// conditional, shows the command, and a skipped firing is its own state with
// the guard's reason, never a Missed or Failed lookalike.

const DESKTOP = { width: 1280, height: 900 };
const GUARD = "python C:/Users/tecno/.claude/skills/clockify-reconciliator/check.py";

/** Local wall-clock instant today at `hour:minute`, as the RFC3339 the backend sends. */
function today(hour: number, minute = 0): string {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), hour, minute, 0, 0).toISOString();
}

const NEW_CHAT_KIND = {
  type: "new_chat", cwd: "C:/Projects/alpha", model: "claude-opus-5", effort: "high",
  account_id: null, placeholder_id: null, character_id: null, auto_accept: false,
} as const;

const BASE: ScheduledItem = {
  id: "base",
  kind: NEW_CHAT_KIND,
  prompt: "Run the Clockify reconciliation skill",
  fire_at: today(23, 55),
  recurrence: null,
  status: { type: "pending" },
  created_at: today(1),
  last_fired_at: null,
  last_result: null,
  last_session_id: null,
  guard: null,
  last_skip: null,
};

const ITEMS: ScheduledItem[] = [
  // Recurring, guarded, and its last firing was turned away this morning.
  {
    ...BASE, id: "g1", guard: GUARD,
    recurrence: { time: "23:55", rule: { type: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6] } },
    last_result: "skipped: already ran for 2026-10-30",
    last_skip: { at: today(8, 30), reason: "already ran for 2026-10-30" },
  },
  // A one-shot whose guard said skip: terminal, but its own state.
  {
    ...BASE, id: "g2", guard: "exit 0", fire_at: today(7), status: { type: "skipped" },
    prompt: "One-off cleanup",
    last_result: "skipped: nothing to clean", last_skip: { at: today(7), reason: "nothing to clean" },
  },
  { ...BASE, id: "p1", fire_at: today(14), prompt: "Plain unguarded item" },
];

test("a guarded item reads as conditional and a skip shows its reason", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await mountView(page, {
    view: "schedule",
    invoke: { schedule_list: ITEMS, schedule_list_external: [], list_instances: [] },
  });

  const rows = page.locator(".agenda-list .agenda-row");
  await expect(rows).toHaveCount(4);

  const upcoming = rows.filter({ hasText: "Upcoming" }).filter({ hasText: "conditional" });
  await expect(upcoming).toHaveCount(1);
  await expect(upcoming).toContainText("Skips if");
  await expect(upcoming).toContainText("clockify-reconciliator/check.py");

  const history = rows.filter({ has: page.locator(".schedule-status-pill--skipped") }).filter({ hasText: "already ran" });
  await expect(history).toHaveCount(1);
  await expect(history.locator(".schedule-reason--skipped")).toHaveText("already ran for 2026-10-30");
  await expect(history.locator("[data-action]")).toHaveCount(0);
  await expect(history).not.toHaveClass(/agenda-row--nav/);

  const oneShot = rows.filter({ hasText: "nothing to clean" });
  await expect(oneShot.locator(".schedule-status-pill--skipped")).toHaveText("Skipped");
  await expect(oneShot.locator('[data-action="delete"]')).toHaveCount(1);

  const plain = rows.filter({ hasText: "Upcoming" }).filter({ hasNotText: "conditional" });
  await expect(plain).toHaveCount(1);
  await expect(plain.locator(".schedule-badge--guard")).toHaveCount(0);

  // The view fades in; shoot the settled agenda, not a half-opaque frame.
  await page.waitForTimeout(900);
  await capture(page.locator(".agenda"), "schedule-guard-agenda");
});
