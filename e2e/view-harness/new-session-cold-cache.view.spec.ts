// asserts: src/views/sessions/project-picker.ts, src/views/sessions/pending-flow.ts
// Reviewed 2026-10-20 (Mac-mirrored project icon fix): project-picker.ts's row render now passes a machineId to renderAvatar - this spec never selects a peer machine, so it stays null and the markup is unchanged.
// Reviewed 2026-10-23 (peer project stats): project-picker.ts now reads row stats through statFor() and hides the worktree badge on peer rows - this spec only drives the local list, where both are unchanged.
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, delayInvokes } from "./harness";
import { shotDir } from "./shot-dir";

// Todo 809: forces new-session-cache.ts's cold-cache path (boot's own
// warmNewSessionCache() otherwise always warms it first) so each cold step's
// own loading shell actually renders. The delay is an addInitScript ahead of
// the boot navigation - too late post-mount. The project picker shows its own
// skeleton (project-picker.ts, matches the real card's size); after the pick
// there is no second dialog, the draft chat pane opens once the cold
// per-project reads resolve.

// shotDir() resolves the running session's own id and creates the directory - never a
// hand-rolled literal (todo 958).
const SCREENSHOT_DIR = shotDir();

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, tokens_7d: 0, live: 0,
  any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
};

const ACCOUNTS = [{ id: "acc1", label: "work", icon: "briefcase", colour: "#8b5cf6" }];

const DELAY_MS = 2000;
// resolve_project_account is never boot-warmed (new-session-cache.ts only
// warms it lazily per-project), so it alone already makes the draft's config
// resolve cold; list_project_groups/list_accounts/list_projects are
// boot-warmed, so they need the delay to reproduce the cold project-picker too.
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

  test("cold project-picker shows its skeleton shell, then the draft pane opens with no second dialog", async ({ page }) => {
    await mountColdSessions(page);

    await page.locator("#sessionsFab").click();

    // project-picker's cold shell shares .project-picker-modal's size/position
    // and shows skeleton rows instead of a spinner (project-picker.ts).
    const pickerLoading = page.locator(".project-picker-modal--loading");
    await expect(pickerLoading).toBeVisible();
    await expect(pickerLoading.locator(".project-picker-skeleton-row").first()).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "project-picker-cold.png") });

    await expect(page.locator(".project-picker-modal")).toBeVisible({ timeout: DELAY_MS + 2000 });

    await page.locator(".project-picker-row").click();

    // No model/effort dialog any more: the draft pane opens straight away on
    // the resolved defaults once the delayed reads land.
    await expect(page.locator("#session-pane .session-composer .composer-textarea")).toBeVisible({ timeout: DELAY_MS + 2000 });
    await expect(page.locator(".modal-card")).toHaveCount(0);
    expect(existsSync(path.join(SCREENSHOT_DIR, "project-picker-cold.png"))).toBe(true);
  });

  test("rapid double-clicks on the FAB open exactly one modal instance", async ({ page }) => {
    await mountColdSessions(page);

    const fab = page.locator("#sessionsFab");
    await Promise.all([fab.click(), fab.click()]);

    await expect(page.locator(".modal-card")).toHaveCount(1);
  });
});
