import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, delayInvokes } from "./harness";
import { shotDir } from "./shot-dir";

// Todo 809: forces new-session-cache.ts's cold-cache path (boot's own
// warmNewSessionCache() otherwise always warms it first) so
// .modal-card-loading (src/shared/modal.css) actually renders. The delay is
// an addInitScript ahead of the boot navigation - too late post-mount.

// shotDir() resolves the running session's own id and creates the directory - never a
// hand-rolled literal (todo 958).
const SCREENSHOT_DIR = shotDir();

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_remote: false, any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
};

const ACCOUNTS = [{ id: "acc1", label: "work", icon: "briefcase", colour: "#8b5cf6" }];

const DELAY_MS = 2000;
// resolve_project_account is never boot-warmed (new-session-cache.ts only
// warms it lazily per-project), so it alone already forces the model/effort
// step cold; list_project_groups/list_accounts/list_projects are boot-warmed,
// so they need the delay to reproduce the cold project-picker step too.
const DELAYED_COMMANDS = ["list_project_groups", "list_accounts", "list_projects", "resolve_project_account"];

async function mountColdSessions(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [],
      get_active_sessions: [],
      list_project_groups: [PROJECT],
      list_accounts: ACCOUNTS,
      list_projects: [],
      resolve_project_account: null,
      project_last_activity_at: 0,
      count_ai_todos: 0,
      list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
    },
  });
  await delayInvokes(page, DELAYED_COMMANDS, DELAY_MS);
  await page.locator("#sessionsFab").waitFor();
}

// .sessions-fab is display:none above 640px (session-list.css) - it's the
// phone session list's entry point to the same startNewSession() the desktop
// kebab's "+ New session" item calls, so a mobile viewport is required.
test.describe("view-harness / new-session cold cache", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("cold project-picker and model/effort steps show the loading spinner shell", async ({ page }) => {
    await mountColdSessions(page);

    await page.locator("#sessionsFab").click();

    const loadingCard = page.locator(".modal-card-loading");
    await expect(loadingCard).toBeVisible();
    await expect(loadingCard).toContainText("Loading projects");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "project-picker-cold.png") });

    await expect(page.locator(".project-picker-modal")).toBeVisible({ timeout: DELAY_MS + 2000 });

    await page.locator(".project-picker-row").click();

    await expect(loadingCard).toBeVisible();
    await expect(loadingCard).toContainText("Loading");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "model-effort-cold.png") });

    await expect(page.locator(".model-effort-modal-card")).toBeVisible({ timeout: DELAY_MS + 2000 });
    expect(existsSync(path.join(SCREENSHOT_DIR, "project-picker-cold.png"))).toBe(true);
    expect(existsSync(path.join(SCREENSHOT_DIR, "model-effort-cold.png"))).toBe(true);
  });

  test("rapid double-clicks on the FAB open exactly one modal instance", async ({ page }) => {
    await mountColdSessions(page);

    const fab = page.locator("#sessionsFab");
    await Promise.all([fab.click(), fab.click()]);

    await expect(page.locator(".modal-card")).toHaveCount(1);
  });
});
