import { expect, test } from "@playwright/test";
import { mountView } from "./harness";
import type { ScheduledItem } from "../../src/types/ipc.generated";

// asserts: src/views/schedule/schedule-render.ts, src/views/schedule/schedule-format.ts, src/views/schedule/schedule.ts

// A due after-meeting item is held by the daemon, so its row reads "Waiting
// for the meeting to end" instead of an Upcoming pill, and every after-meeting
// row carries a marker that opens a drawer. An ordinary due item is unchanged.

/** Local wall-clock instant today at `hour:minute`, as the RFC3339 the backend sends. */
function today(hour: number, minute = 0): string {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), hour, minute, 0, 0).toISOString();
}

const BASE: ScheduledItem = {
  id: "base",
  kind: {
    type: "new_chat", cwd: "C:/Projects/alpha", model: "claude-opus-5", effort: "high",
    account_id: null, placeholder_id: null, character_id: null, auto_accept: false,
  },
  prompt: "x",
  fire_at: today(12),
  recurrence: null,
  status: { type: "pending" },
  created_at: today(1),
  last_fired_at: null,
  last_result: null,
  last_session_id: null,
  guard: null,
  last_skip: null,
};

test("a due after-meeting item reads as waiting and every after-meeting row has a marker", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // Fixed clock so "due" and "not yet due" do not depend on when the suite runs.
  await page.clock.install({ time: new Date(new Date().setHours(12, 30, 0, 0)) });
  await mountView(page, {
    view: "schedule",
    invoke: {
      schedule_list: [
        { ...BASE, id: "m-due", prompt: "Waits, due", fire_at: today(12, 0), after_meeting: true },
        { ...BASE, id: "m-later", prompt: "Waits, later", fire_at: today(23, 0), after_meeting: true },
        { ...BASE, id: "plain-due", prompt: "Plain, due", fire_at: today(12, 10) },
      ],
      schedule_list_external: [],
      list_instances: [],
    },
  });

  const rows = page.locator(".agenda-list .agenda-row");
  await expect(rows).toHaveCount(3);
  const due = rows.filter({ has: page.locator(".schedule-meeting-btn") }).filter({ hasText: "Waiting for the meeting to end" });
  await expect(due).toHaveCount(1);
  await expect(due.locator(".schedule-status-pill")).toHaveCount(0);

  await expect(page.locator(".schedule-meeting-btn")).toHaveCount(2);
  const later = rows.filter({ has: page.locator(".schedule-meeting-btn") }).filter({ hasText: "Upcoming" });
  await expect(later).toHaveCount(1);

  const plain = rows.filter({ hasText: "Upcoming" }).filter({ hasNot: page.locator(".schedule-meeting-btn") });
  await expect(plain).toHaveCount(1);
  await expect(plain).not.toContainText("Waiting");

  await expect(page.locator(".schedule-meeting-drawer")).toHaveCount(0);
  await due.locator(".schedule-meeting-btn").click();
  await expect(due.locator(".schedule-meeting-drawer")).toContainText("20 seconds");
  await due.locator(".schedule-meeting-btn").click();
  await expect(page.locator(".schedule-meeting-drawer")).toHaveCount(0);
});
