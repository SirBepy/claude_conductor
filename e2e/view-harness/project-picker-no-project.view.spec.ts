import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// asserts: src/views/sessions/project-picker.ts, src/views/sessions/new-session-cache.ts, src/shared/no-project.ts

// "No project" is a real folder (the Obsidian vault) that must read as no
// project at all: renamed, pinned first whatever the sort, its path hidden,
// and picking it skips the worktree/start-folder step.

function proj(name: string, path: string) {
  return {
    id: `id-${name}`, path, name, parent_segment: null,
    avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
    any_remote: false, any_automated: false, last_active_at: null,
    path_exists: true, worktrees: [],
    last_worktree_path: null, last_start_folder_rel: null,
  };
}

const VAULT = "C:\\Users\\joe\\Documents\\ObsidianVault";

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: [
    proj("countoff", "C:\\Projects\\countoff"),
    proj("ObsidianVault", VAULT),
    proj("zng-app", "C:\\Projects\\zng-app"),
  ],
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [
    { rel_path: "", label: "Repo root", nested: false },
    { rel_path: "notes", label: "notes", nested: true },
  ],
  list_worktree_details: [],
};

async function openPicker(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, { invoke: BASE_INVOKE });
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.waitForSelector(".project-picker-row");
}

test.describe("view-harness / project picker No project row", () => {
  test("the vault renders as No project, first, without its path", async ({ page }) => {
    await openPicker(page);

    const names = await page.locator(".project-picker-name").allTextContents();
    expect(names).toEqual(["No project", "countoff", "zng-app"]);
    const first = page.locator(".project-picker-row").first();
    await expect(first.locator(".project-picker-path")).not.toContainText("ObsidianVault");
    await expect(first.locator(".project-picker-avatar .ph-circle-dashed")).toHaveCount(1);
  });

  test("picking No project skips the location step", async ({ page }) => {
    await openPicker(page);

    await page.locator(".project-picker-row").first().click();

    await expect(page.locator('[data-picker-step="project"]')).toHaveCount(0);
    await expect(page.locator('[data-picker-step="location"]')).toHaveCount(0);
  });
});
