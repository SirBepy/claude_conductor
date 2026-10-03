import { expect, test, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Statusline location chips driven in a real browser: repo + folder stay silent
// until the AI leaves the folder the chat was opened in.

const DESKTOP = { width: 1400, height: 900 };
const SPAWN = "C:/Projects/alpha";
const SESSIONS = [sessionInstance({ cwd: SPAWN })];
const ROW = ["model", "branch", "repo", "folder", "commits"];

const GIT_INFO = {
  branch: "master", repo: "claude_conductor", ahead: 2, behind: 1,
  sha: "abc1234", insertions: 0, deletions: 0,
};

const SYNC = {
  ahead: [
    { short_sha: "9f1c2ab", message: "FIX: keep an AUQ attachment on its step" },
    { short_sha: "3ab77e0", message: "STYLE: right-align the review row chip" },
  ],
  behind: [{ short_sha: "77aa019", message: "chore: bump vite" }],
  has_upstream: true,
};

async function mountStatusbar(page: Page, liveCwd: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      session_live_cwd: liveCwd,
      get_git_info: GIT_INFO,
      get_git_dirty: [],
      get_commit_sync: SYNC,
      get_settings: { theme: "void", statuslineRows: [ROW], statuslineRowsMobile: [ROW] },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
  await page.locator("#session-pane .sb-row").first().waitFor();
  // The clicked sidebar row keeps its hover tooltip up, over the chip strip.
  await page.mouse.move(1200, 700);
  await expect(page.locator("#session-pane .sb-branch")).toContainText("master");
}

/** Captures are for showing Joe the pixels; the asserts above them are the test. */
async function shot(target: Parameters<typeof capture>[0], label: string): Promise<void> {
  if (process.env.CC_SHOTS) await capture(target, label);
}

test.describe("statusline location chips", () => {
  test("repo + folder stay hidden while the session sits in its spawn dir", async ({ page }) => {
    await mountStatusbar(page, SPAWN);

    const bar = page.locator("#session-pane .session-statusbar");
    await expect(bar.locator(".sb-repo")).toHaveCount(0);
    await expect(bar.locator(".sb-folder")).toHaveCount(0);
    await expect(bar.locator(".sb-skeleton[data-skeleton='repo']")).toHaveCount(0);
    await expect(bar.locator(".sb-commits")).toBeVisible();
    await page.waitForTimeout(400); // sb-chip-in fade
    await shot(page.locator("#session-pane"), "location-chips-hidden-in-spawn-dir");
  });

  test("both appear once the AI moves into a worktree", async ({ page }) => {
    await mountStatusbar(page, "C:/Projects/wt-alpha-feature");

    const bar = page.locator("#session-pane .session-statusbar");
    await expect(bar.locator(".sb-folder")).toContainText("wt-alpha-feature");
    await expect(bar.locator(".sb-repo")).toContainText("claude_conductor");
    await page.waitForTimeout(400);
    await shot(page.locator("#session-pane"), "location-chips-shown-after-worktree-move");
  });
});
