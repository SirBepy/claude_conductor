import { test, expect, type Page } from "@playwright/test";
// Reviewed 2026-10-28: dash-menu.ts's file-row menu now offers Open (the app's Files window) before Open in VS Code; this spec drives no file row, so its contract is unaffected. Passed after the change.
// asserts: src/views/sessions/project-dashboard/dash-menu.ts, src/views/sessions/chat-menu-items.ts, src/views/sessions/channel-actions.ts
import { capture, invokeCalls, mountSessionsList, sessionInstance } from "./harness";
import { CONDUCTOR_CWD, LIST_ROWS, conductorHistory, conductorSnapshot } from "./project-dashboard-fixtures";

// An automated channel never restarts itself, so Restart / Show terminal /
// Phone link / Stop live in the project dashboard's menu (reachable with the
// channel dead) and in a live channel chat's Agent menu.

const CHANNEL = sessionInstance({
  session_id: "s-ch", pid: 301, name: "Channel: conductor", cwd: CONDUCTOR_CWD,
  kind: "automated", project_id: "p-conductor", bridge_session_id: "bridge-1",
});

async function mount(page: Page, automationEnabled: boolean): Promise<void> {
  await page.setViewportSize({ width: 1032, height: 900 });
  await mountSessionsList(page, [CHANNEL], {
    dashboard_list_targets: LIST_ROWS,
    dashboard_snapshot: conductorSnapshot(),
    dashboard_history: conductorHistory(),
    list_projects: [{ id: "p-conductor", path: CONDUCTOR_CWD, name: "claude_usage_in_taskbar", automation: automationEnabled ? { enabled: true } : null }],
    restart_channel: null,
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    list_slash_commands: [],
    get_git_dirty: null,
  });
  // The Remote segment, where an automated channel lands, starts collapsed.
  await page.locator('li[data-seg-toggle="7"]').click();
}

test.describe("view-harness / channel controls", () => {
  test("the dashboard's project menu carries the channel block when automation is on", async ({ page }) => {
    await mount(page, true);
    await page.locator('#sessions-list li[data-session-id="s-ch"]').click();
    await page.locator("#session-pane .session-header .meta-proj").click();
    await page.locator('.pd-head button[title="More"]').click();
    const items = page.locator(".session-more-menu .smore-item");
    await expect(items.filter({ hasText: "Restart channel" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Show terminal" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Phone link" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Stop channel" })).toHaveClass(/is-danger/);
    await capture(page, "channel-project-menu");

    await items.filter({ hasText: "Restart channel" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "restart_channel")).toEqual([
      { cmd: "restart_channel", args: { projectId: "p-conductor" } },
    ]);
  });

  test("the channel block is absent when automation is off", async ({ page }) => {
    await mount(page, false);
    await page.locator('#sessions-list li[data-session-id="s-ch"]').click();
    await page.locator("#session-pane .session-header .meta-proj").click();
    await page.locator('.pd-head button[title="More"]').click();
    await expect(page.locator(".session-more-menu .smore-item", { hasText: "Folder mapping" })).toBeVisible();
    await expect(page.locator(".session-more-menu .smore-item", { hasText: "Restart channel" })).toHaveCount(0);
  });

  test("a live channel's chat menu offers the same controls under Agent", async ({ page }) => {
    await mount(page, true);
    await page.locator('#sessions-list li[data-session-id="s-ch"]').click({ button: "right" });
    await page.locator(".smore-has-sub", { hasText: "Agent" }).click();
    const sub = page.locator('.chat-menu-submenu[data-sub-for="Agent"]');
    await expect(sub.locator(".smore-item", { hasText: "Restart channel" })).toBeVisible();
    await expect(sub.locator(".smore-item", { hasText: "Phone link" })).toBeVisible();
    await capture(page, "channel-chat-menu");
  });
});
