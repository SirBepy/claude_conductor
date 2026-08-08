import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Popup/overlay overhaul regression coverage (Joe's report, 2026-08-08):
// #modal-host stays open across the project -> location -> worktree chain,
// and the cleanup confirm renders above the picker sharing one backdrop.
// Drives the real chain via the __startNewSession e2e seam (main.ts).

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_remote: false, any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [{ path: "C:/repo/wt-a", name: "wt-a", tokens_7d: 0, live: 0, last_active_at: null, path_exists: true }],
  last_worktree_path: null, last_start_folder_rel: null,
};

const WORKTREE_DETAILS = [
  { path: "C:/repo/wt-a", name: "wt-a", branch: "feature-a", last_commit_at: null, stale: false, stale_reason: null },
  { path: "C:/repo/wt-b", name: "wt-b", branch: "old-branch", last_commit_at: null, stale: true, stale_reason: "branch deleted upstream" },
];

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: [PROJECT],
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: WORKTREE_DETAILS,
};

async function startChain(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, { invoke: BASE_INVOKE });
  // Fire-and-forget: __startNewSession's promise only resolves once the
  // whole flow finishes (or is cancelled) - these tests assert mid-chain.
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
}

test.describe("view-harness / popup chain morph + confirm stacking", () => {
  test("host stays open continuously across project -> location -> worktree steps", async ({ page }) => {
    await startChain(page);

    await page.locator(".project-picker-row").click();
    await expect(page.locator("#modal-host")).toHaveClass(/\bopen\b/);

    await page.locator(".loc-chip").click(); // "Change worktree" chip -> worktree-picker choice screen
    await expect(page.locator("#modal-host")).toHaveClass(/\bopen\b/);
    await expect(page.locator(".wt-picker-modal")).toBeVisible();

    await page.locator(".wt-picker-choice", { hasText: "Existing worktree" }).click();
    await expect(page.locator("#modal-host")).toHaveClass(/\bopen\b/);
    await expect(page.locator(".wt-picker-row--stale")).toBeVisible();
  });

  test("cleanup confirm renders above the worktree picker with a single backdrop tint", async ({ page }) => {
    await startChain(page);
    await page.locator(".project-picker-row").click();
    await page.locator(".loc-chip").click();
    await page.locator(".wt-picker-choice", { hasText: "Existing worktree" }).click();

    const cleanupBtn = page.locator(".wt-picker-cleanup-btn");
    await expect(cleanupBtn).toBeEnabled(); // wt-b is pre-checked (stale, loadDetails auto-selects it)
    await cleanupBtn.click();

    const confirmOverlay = page.locator(".app-confirm-overlay");
    await expect(confirmOverlay).toBeVisible();

    // Bug #3: reuses #modal-host's tint instead of painting its own on top.
    await expect(confirmOverlay).toHaveClass(/app-confirm-overlay--bare/);
    const confirmBg = await confirmOverlay.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(confirmBg).toBe("rgba(0, 0, 0, 0)");

    // Bug #2: confirm's own z-index tier must clear the picker card's.
    const [confirmZ, cardZ] = await Promise.all([
      confirmOverlay.evaluate((el) => Number(getComputedStyle(el).zIndex)),
      page.locator(".wt-picker-modal").evaluate((el) => Number(getComputedStyle(el).zIndex)),
    ]);
    expect(confirmZ).toBeGreaterThan(cardZ);

    // And it's genuinely clickable (not just numerically on top but visually
    // obscured/unreachable) - confirming actually dismisses the dialog.
    await page.locator(".app-confirm-ok").click();
    await expect(confirmOverlay).toHaveCount(0);
  });
});
