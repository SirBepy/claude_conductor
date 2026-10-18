// asserts: src/views/sessions/model-effort-modal.ts, src/shared/modal-input-lock.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, delayInvokes } from "./harness";

// Joe, 2026-10-19: a New session card popped up after the chat flow was
// already over and nothing got rid of it - backdrop click and Escape did
// nothing, and ctrl+r was swallowed too. Cause: closing the cold model/effort
// step while it still showed its loading shell, after which loadAndBuild()'s
// late presentHostCard() re-opened the host on a card nobody owned any more.
// resolve_project_account is never boot-warmed, so the first new chat per
// project always takes this cold path.

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
};
const ACCOUNTS = [{ id: "acc1", label: "work", icon: "briefcase", colour: "#8b5cf6" }];
const DELAY_MS = 1500;

async function openColdModelEffortShell(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [], get_active_sessions: [],
      list_project_groups: [PROJECT], list_accounts: ACCOUNTS, list_projects: [],
      resolve_project_account: null, project_last_activity_at: 0, count_ai_todos: 0,
      list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
      get_history: [],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await delayInvokes(page, ["resolve_project_account"], DELAY_MS);
  await page.locator("#viewMoreBtn").waitFor();
  await page.keyboard.press("Control+n");
  await page.locator(".project-picker-row").click();
  await page.locator("#modal-host .modal-card-loading").waitFor();
}

async function expectStaysClosed(page: Page): Promise<void> {
  await expect(page.locator("#modal-host")).not.toHaveClass(/\bopen\b/);
  // Past the delayed read, so the late loadAndBuild() has had its chance.
  await page.waitForTimeout(DELAY_MS + 700);
  await expect(page.locator("#modal-host")).not.toHaveClass(/\bopen\b/);
  await expect(page.locator(".model-effort-modal-card")).toHaveCount(0);
  const reloadAllowed = await page.evaluate(() => {
    const ev = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    return !ev.defaultPrevented;
  });
  expect(reloadAllowed).toBe(true);
}

test.describe("view-harness / cold New session closed mid-load stays closed", () => {
  test("Escape on the loading shell", async ({ page }) => {
    await openColdModelEffortShell(page);
    await page.keyboard.press("Escape");
    await expectStaysClosed(page);
  });

  test("backdrop click on the loading shell", async ({ page }) => {
    await openColdModelEffortShell(page);
    await page.mouse.click(5, 5);
    await expectStaysClosed(page);
  });
});
