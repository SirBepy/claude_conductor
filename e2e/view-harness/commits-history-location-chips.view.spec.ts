import { expect, test, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Two statusline changes driven in a real browser: repo + folder are location
// chips now (silent until the AI leaves the folder the chat was opened in), and
// the git card lists branch history as one scrolling list with the unpushed rows
// marked apart from the pushed ones.

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

function history(): { entries: unknown[]; has_more: boolean; has_upstream: boolean } {
  const base = 1_770_000_000;
  const unpushed = SYNC.ahead.map((c, i) => ({
    short_sha: c.short_sha, message: c.message, pushed: false, timestamp: base - i * 5400,
  }));
  const messages = [
    "FIX: keep pre-meta-tick calls in the open turn's chip strip",
    "FIX: render a tool chip's panel from the calls it counted",
    "FIX: use fractional height for the question card's track clip",
    "FEAT: page the commits popover",
    "DOCS: note the worktree bootstrap step",
    "TEST: cover the statusline location chips",
  ];
  // 18 rows, enough to overflow the list's 260px cap so the scroll is real.
  const pushed = Array.from({ length: 18 }, (_, i) => messages[i % messages.length]).map((message, i) => ({
    short_sha: `c0${i}de${i}f`, message, pushed: true, timestamp: base - (i + 3) * 86_400,
  }));
  return { entries: [...unpushed, ...pushed], has_more: false, has_upstream: true };
}

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
      get_commit_history: history(),
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

test.describe("git card history", () => {
  test("lists pushed and unpushed commits in one scrolling list", async ({ page }) => {
    await mountStatusbar(page, SPAWN);

    await page.locator("#session-pane .sb-commits-btn").click();
    const popover = page.locator(".sb-git-card");
    await expect(popover).toBeVisible();
    await expect(popover.locator(".sb-git-pop-push-btn")).toBeVisible();
    await expect(popover.locator(".sb-git-pop-section.behind")).toContainText("Incoming");

    const list = popover.locator(".sb-commit-history");
    await expect(list.locator(".sb-history-row")).toHaveCount(20);
    await expect(list.locator(".sb-history-row.unpushed")).toHaveCount(2);
    await expect(list.locator(".sb-history-row.pushed")).toHaveCount(18);
    // The list owns the scroll, so the header + Push button stay put above it.
    await expect(list).toHaveCSS("overflow-y", "auto");
    const scrollable = await list.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrollable, "history list should scroll rather than grow the popover").toBe(true);

    await shot(popover, "git-card-pushed-history");
  });
});
