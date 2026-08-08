import { test, expect } from "@playwright/test";
import { mountView, invokeCalls } from "./harness";

// "New worktree" redesign (Joe, 2026-08-08): no more typed branch-name form -
// a random human-readable name is pre-filled (editable, rerollable), and the
// base branch is picked from a list instead of typed, always sent explicitly
// so the backend fetches it fresh (src-tauri/src/ipc/worktrees.rs).

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_remote: false, any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [{ path: "C:/repo/wt-a", name: "wt-a", tokens_7d: 0, live: 0, last_active_at: null, path_exists: true }],
  last_worktree_path: null, last_start_folder_rel: null,
};

const BRANCHES = [
  { name: "feature-a", current: true, short_sha: "abc123", upstream: "origin/feature-a" },
  { name: "develop", current: false, short_sha: "def456", upstream: "origin/develop" },
  { name: "main", current: false, short_sha: "ghi789", upstream: "origin/main" },
];

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: [PROJECT],
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  get_recent_branches: BRANCHES,
  create_worktree: { path: "C:/repo/.claude/worktrees/swift-otter", name: "swift-otter", branch: "swift-otter", last_commit_at: null, stale: false, stale_reason: null },
};

async function openNewWorktreeStep(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, { invoke: BASE_INVOKE });
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.locator(".project-picker-row").click();
  await page.locator(".loc-chip").click();
  await page.locator(".wt-picker-choice", { hasText: "New worktree" }).click();
}

test.describe("view-harness / New worktree random naming", () => {
  test("name is pre-filled random and rerollable, no typed base-branch field", async ({ page }) => {
    await openNewWorktreeStep(page);

    const nameInput = page.locator(".wt-new-name-row input");
    const first = await nameInput.inputValue();
    expect(first).toMatch(/^[a-z]+-[a-z]+$/);

    await page.locator(".wt-new-name-reroll").click();
    const second = await nameInput.inputValue();
    expect(second).toMatch(/^[a-z]+-[a-z]+$/);

    // The old typed "Base branch" text input is gone - it's a chip/picker now.
    await expect(page.locator("input[placeholder='current branch']")).toHaveCount(0);
  });

  test("base branch defaults to current, and is pickable from the branch list", async ({ page }) => {
    await openNewWorktreeStep(page);

    const chip = page.locator(".loc-chip .loc-chip-value");
    await expect(chip).toHaveText("feature-a");
    await expect(page.locator(".loc-chip .loc-chip-sub")).toHaveText("current branch");

    await page.locator(".loc-chip").click();
    await page.locator(".wt-picker-row-name", { hasText: "develop" }).click();
    await expect(chip).toHaveText("develop");
  });

  test("Create sends the picked name + base branch, and worktreeName null", async ({ page }) => {
    await openNewWorktreeStep(page);
    await page.locator(".wt-new-name-row input").fill("my-custom-name");
    await page.locator(".btn-primary", { hasText: "Create" }).click();

    const calls = await invokeCalls(page);
    const create = calls.find((c) => c.cmd === "create_worktree");
    expect(create?.args).toEqual({
      repoPath: "C:/repo",
      branchName: "my-custom-name",
      worktreeName: null,
      baseBranch: "feature-a",
    });
  });
});
