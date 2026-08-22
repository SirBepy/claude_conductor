import { expect, test, type Page } from "@playwright/test";
import { capture, mountView } from "./harness";
import type { MissedEntry } from "../../src/missed-panel";
import type { ScheduledItem } from "../../src/types/ipc.generated";

// Todo 403: renders the v0.2.31 surfaces that were never observed running -
// the schedule Month/Week toggle, the missed-panel's PERMANENT dismissal, and
// the project picker's worktree folding.

const DESKTOP = { width: 1280, height: 900 };
const TALL = { width: 1280, height: 1400 };

/** Local wall-clock instant `days` from today, as the RFC3339 the backend sends. */
function dayShift(days: number, hour: number, minute = 0): string {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + days, hour, minute, 0, 0).toISOString();
}

const ITEM_BASE: ScheduledItem = {
  id: "base",
  kind: { type: "message", session_id: "s2", cwd: "C:/Projects/alpha" },
  prompt: "Scheduled message",
  fire_at: dayShift(0, 9),
  recurrence: null,
  status: { type: "pending" },
  created_at: dayShift(-20, 9),
  last_fired_at: null,
  last_result: null,
  last_session_id: null,
};

function item(over: Partial<ScheduledItem>): ScheduledItem {
  return { ...ITEM_BASE, ...over };
}

const NEW_CHAT_KIND = {
  type: "new_chat", cwd: "C:/Projects/alpha", model: "claude-opus-5", effort: "high",
  account_id: null, placeholder_id: null, character_id: null, auto_accept: false,
} as const;

const ITEMS: ScheduledItem[] = [
  item({ id: "i1", fire_at: dayShift(0, 9, 30), kind: { type: "message", session_id: "s1", cwd: "C:/Projects/alpha" }, prompt: "Post the standup summary" }),
  item({ id: "i2", fire_at: dayShift(0, 15), kind: NEW_CHAT_KIND, prompt: "Kick off the dependency audit" }),
  item({ id: "i3", fire_at: dayShift(-2, 10), status: { type: "sent" }, last_fired_at: dayShift(-2, 10), prompt: "Archive last week's todos" }),
  item({ id: "i4", fire_at: dayShift(-1, 8), status: { type: "missed" }, last_fired_at: dayShift(-1, 8), prompt: "Reply to the release thread" }),
  item({ id: "i5", fire_at: dayShift(-3, 17), status: { type: "failed", reason: "session not found" }, last_fired_at: dayShift(-3, 17), prompt: "Rerun the flaky spec" }),
  item({ id: "r1", fire_at: dayShift(-7, 9), recurrence: { time: "09:00", rule: { type: "daily" } }, prompt: "Daily hygiene sweep" }),
  item({ id: "r2", fire_at: dayShift(-7, 14, 30), recurrence: { time: "14:30", rule: { type: "weekly", weekdays: [0, 2, 4] } }, prompt: "Triage the backlog" }),
  item({ id: "i6", fire_at: dayShift(9, 11), prompt: "Draft the v0.3 release notes" }),
  item({ id: "i7", fire_at: dayShift(16, 13), kind: NEW_CHAT_KIND, prompt: "Start the Q4 planning chat" }),
];

const SCHEDULE_INVOKE = {
  schedule_list: ITEMS,
  schedule_list_external: [],
  list_instances: [{ session_id: "s1", name: "Alpha chat" }],
};

const MISSED: MissedEntry[] = [
  { id: "m-1", name: "Reply to the release thread", time: "Aug 21, 08:00", kind: "message" },
  { id: "m-2", name: "New chat: alpha", time: "Aug 21, 09:15", kind: "new_chat" },
  { id: "m-3", name: "Rerun the flaky spec", time: "Aug 20, 17:00", kind: "message" },
];

async function pushMissed(page: Page, entries: MissedEntry[]): Promise<void> {
  await page.evaluate(async (rows) => {
    const mod = await import("/missed-panel.ts");
    mod.updateMissedPanel(rows, () => { /* no navigation in the harness */ });
  }, entries);
}

const WORKTREES = [
  { path: "C:/repo/.claude/worktrees/swift-otter", name: "swift-otter", tokens_7d: 0, live: 0, last_active_at: null, path_exists: true },
  { path: "C:/repo/.claude/worktrees/calm-heron", name: "calm-heron", tokens_7d: 0, live: 0, last_active_at: null, path_exists: true },
];

const REPO_PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_remote: false, any_automated: false, last_active_at: null, path_exists: true,
  worktrees: WORKTREES, last_worktree_path: null, last_start_folder_rel: null,
};

const PLAIN_PROJECT = {
  ...REPO_PROJECT, id: "proj2", path: "C:/other", name: "other", worktrees: [],
};

const PICKER_INVOKE = {
  list_project_groups: [REPO_PROJECT, PLAIN_PROJECT],
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: WORKTREES.map((w) => ({
    path: w.path, name: w.name, branch: w.name, last_commit_at: "2026-08-19T10:00:00Z",
    stale: false, stale_reason: null,
  })),
};

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("schedule month + week views", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { view: "schedule", invoke: SCHEDULE_INVOKE });

    const view = page.locator(".view-schedule");
    await expect(view).toBeVisible();
    await expect(page.locator(".cal-grid")).toBeVisible();
    await expect(page.locator(".cal-cell")).toHaveCount(42);
    await expect(page.locator(".view-toggle button.active")).toHaveText("Month");
    await expect(page.locator(".cal-cell.today .cal-dots .dot")).not.toHaveCount(0);
    await expect(page.locator(".agenda-list .agenda-row")).not.toHaveCount(0);
    await expect(page.locator(".agenda-list")).toContainText("Alpha chat");
    await capture(page, "schedule-month-view");

    await page.setViewportSize(TALL);
    await page.locator("[data-view-mode='week']").click();
    await expect(page.locator(".view-toggle button.active")).toHaveText("Week");
    await expect(page.locator(".week-day")).toHaveCount(7);
    // The daily recurrence starts a week back, so every visible day counts >= 1.
    const counts = await page.locator(".week-day-head .schedule-count-chip").allTextContents();
    expect(counts).toHaveLength(7);
    expect(counts.every((c) => Number(c) >= 1)).toBe(true);
    await expect(page.locator(".week-day-rows .agenda-row").first()).toBeVisible();
    await capture(page, "schedule-week-view");

    await page.locator(".week-day-head").first().click();
    await expect(page.locator(".week-day.collapsed")).toHaveCount(1);
  });

  test("dismissed missed item stays gone across a reload", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: PICKER_INVOKE });
    await pushMissed(page, MISSED);

    const panel = page.locator(".missed-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".missed-row")).toHaveCount(3);
    await expect(panel.locator(".missed-head-count")).toHaveText("3");
    await expect(panel).toContainText("New chat: alpha");
    await capture(panel, "missed-panel-open");

    await panel.locator('.missed-row[data-id="m-2"] [data-dismiss]').click();
    await expect(panel.locator(".missed-row")).toHaveCount(2);

    await page.reload();
    // Proves the reload really tore the DOM down, so the counts below come from
    // a fresh module instance reading localStorage, not a surviving one.
    await expect(page.locator(".missed-panel")).toHaveCount(0);
    await pushMissed(page, MISSED);
    await expect(panel).toBeVisible();
    await expect(panel.locator(".missed-row")).toHaveCount(2);
    await expect(panel.locator('.missed-row[data-id="m-2"]')).toHaveCount(0);
    await expect(panel).not.toContainText("New chat: alpha");
    await capture(panel, "missed-panel-after-reload");
  });

  test("worktrees fold under their project in the picker", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: PICKER_INVOKE });
    await page.evaluate(() => {
      void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
    });

    const modal = page.locator(".project-picker-modal");
    await expect(modal).toBeVisible();
    // Folded: 2 project rows, not 4 - the worktree paths are not siblings.
    await expect(modal.locator(".project-picker-row")).toHaveCount(2);
    await expect(modal.locator(".project-picker-path", { hasText: "worktrees" })).toHaveCount(0);
    const repoRow = modal.locator(".project-picker-row", { hasText: "C:/repo" });
    await expect(repoRow.locator(".project-picker-wt-badge")).toHaveText("2");
    await capture(modal, "project-picker-worktree-fold");

    await repoRow.click();
    await page.locator(".loc-chip").click();
    await page.locator(".wt-picker-choice", { hasText: "Existing worktree" }).click();
    const wtModal = page.locator(".wt-picker-modal");
    await expect(wtModal.locator(".wt-picker-row-name")).toHaveCount(2);
    await expect(wtModal).toContainText("swift-otter");
    await expect(wtModal).toContainText("calm-heron");
    await capture(wtModal, "project-picker-worktree-nested-list");
  });
});
