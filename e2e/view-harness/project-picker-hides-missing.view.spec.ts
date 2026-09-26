import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// A project whose folder no longer exists was never pickable - selectProjectRow
// returns early on `path_exists === false` - so the row was a dead, grayed
// "This folder doesn't exist" line taking up list space. Joe, 2026-09-26,
// looking at a dozen leftover `wf_*` worktree scratch dirs: hide them.
//
// The daemon-side prune (filter_out_history_only_ghosts) drops the ones with
// no settings.projects entry before they ever reach the frontend; this covers
// the other half - a CONFIGURED project whose folder moved still arrives here
// and must be hidden client-side, not deleted, so reconnecting the drive
// brings it straight back.

function proj(id: string | null, name: string, path: string, pathExists: boolean) {
  return {
    id, path, name, parent_segment: null,
    avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
    any_remote: false, any_automated: false, last_active_at: null,
    path_exists: pathExists, worktrees: [],
    last_worktree_path: null, last_start_folder_rel: null,
  };
}

const PROJECTS = [
  proj("proj-live", "countoff", "C:/Projects/countoff", true),
  proj("proj-gone", "fibo-archived", "C:/Projects/fibo-archived", false),
  proj(null, "wf_eace3d5a-9a1", "wf_eace3d5a-9a1", false),
  proj("proj-live2", "zng-app", "C:/Projects/zng-app", true),
];

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: PROJECTS,
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: [],
};

async function openPicker(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, { invoke: BASE_INVOKE });
  // Fire-and-forget: the promise only resolves once the whole chain finishes.
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.waitForSelector(".project-picker-row");
}

test.describe("view-harness / project picker hides folders that no longer exist", () => {
  test("only the live projects render, in list order", async ({ page }) => {
    await openPicker(page);

    const names = await page.locator(".project-picker-name").allTextContents();
    expect(names).toEqual(["countoff", "zng-app"]);
    await expect(page.locator(".project-picker-row--missing")).toHaveCount(0);
    await expect(page.locator(".project-picker-missing-msg")).toHaveCount(0);
  });

  test("searching for a missing project by name finds nothing, not a dead row", async ({ page }) => {
    await openPicker(page);

    await page.locator("#project-picker-search").fill("fibo-archived");

    await expect(page.locator(".project-picker-row")).toHaveCount(0);
    await expect(page.locator(".project-picker-empty")).toHaveText("No matches");
  });

  test("Enter on a filtered list still picks a live project", async ({ page }) => {
    await openPicker(page);

    await page.locator("#project-picker-search").fill("zng");
    await expect(page.locator(".project-picker-row")).toHaveCount(1);
    await page.locator("#project-picker-search").press("Enter");

    // The chain advanced past the picker rather than dying on a hidden row.
    await expect(page.locator(".project-picker-modal")).toHaveCount(0);
  });
});
