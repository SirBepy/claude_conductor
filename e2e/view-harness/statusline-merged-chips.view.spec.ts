import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The merged git chip and the overflow chip both depend on the real cascade, so
// jsdom cannot see what breaks them: the git chip's segments are coloured and
// divided by rules from session-statusbar.css, and the overflow chip's
// reachability rests on `position: sticky` inside a scrolling row.

const SPAWN = "C:/Projects/zng-app";
const SESSIONS = [sessionInstance({ cwd: SPAWN, name: "Reply to Lenar on claim state" })];

const HISTORY = {
  entries: [
    { short_sha: "a41c9d20", message: "git chip prints only what is unknown", pushed: false, timestamp: 1788000000 },
    { short_sha: "08828e1c", message: "disarm the thinking-bar silence timer", pushed: true, timestamp: 1787992800 },
  ],
  has_more: false,
  has_upstream: true,
};

async function mount(page: Page, over: Record<string, unknown> = {}): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      get_settings: { theme: "glacier", statuslineRowsV2Applied: true },
      session_live_cwd: SPAWN,
      get_git_info: { branch: "master", repo: "zng-app", ahead: 2, behind: 4, sha: "abc1234", insertions: null, deletions: null },
      list_ai_todos: [{ name: "889-git-card.md", path: `${SPAWN}/.claude/todos/889.md` }],
      get_commit_sync: { ahead: [{ short_sha: "a41c9d20", message: "one" }], behind: [], has_upstream: true },
      get_commit_history: HISTORY,
      ...over,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
  await page.locator("#session-pane .sb-git").waitFor();
}

test.describe("view-harness / merged statusline chips", () => {
  test("the git chip renders one chip of divided segments, not three chips", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await mount(page);

    const chip = page.locator("#session-pane .sb-git");
    await expect(chip.locator(".sb-git-seg")).toHaveText(["master", "\u21912", "\u21934"]);
    // Two segments meet at one rule, three at two - the divider is what makes
    // the merge read as one fact rather than as crowded chips.
    await expect(chip.locator(".sb-git-rule")).toHaveCount(2);

    const ruleWidth = await chip.locator(".sb-git-rule").first().evaluate((el) => el.getBoundingClientRect().width);
    expect(ruleWidth).toBeGreaterThan(0);

    // The branch and the behind-count must not resolve to the same colour: the
    // whole point of the segments is that they say different things.
    const colours = await chip.locator(".sb-git-seg").evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
    expect(new Set(colours).size).toBeGreaterThan(1);

    // There is no separate branch/repo/commits chip left to click.
    await expect(page.locator("#session-pane .sb-branch, #session-pane .sb-commits")).toHaveCount(0);
  });

  test("the overflow chip stays inside the row even when the row is scrolled", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    // The drift state is the widest the chip gets: it adds the repo name and a
    // long branch on top of the two counts, which is what overflows a phone.
    await mount(page, {
      session_live_cwd: "C:/Projects/zng-api",
      get_git_info: { branch: "release/2026-09-claim-state", repo: "zng-api", ahead: 2, behind: 4, sha: "abc1234", insertions: null, deletions: null },
    });

    const row = page.locator("#session-pane .sb-row").first();
    const chip = page.locator("#session-pane .sb-overflow");
    await expect(row).toHaveClass(/sb-row-scroll/);

    for (const scrollLeft of [0, 9999]) {
      await row.evaluate((el, x) => { el.scrollLeft = x; }, scrollLeft);
      const box = await row.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const c = el.querySelector(".sb-overflow")!.getBoundingClientRect();
        return { rowRight: r.right, rowLeft: r.left, chipRight: c.right, chipLeft: c.left };
      });
      expect(box.chipRight).toBeLessThanOrEqual(box.rowRight + 1);
      expect(box.chipLeft).toBeGreaterThanOrEqual(box.rowLeft - 1);
    }
    await expect(chip).toBeVisible();
  });

  test("one card carries the branch line and the commit history the two popovers used to split", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await mount(page);

    await page.locator("#session-pane .sb-git-btn").click();
    const card = page.locator(".sb-git-card");
    await expect(card.locator(".gc-branchline .bname")).toHaveText("master");
    await expect(card.locator(".sb-history-row")).toHaveCount(2);
    await expect(card.locator(".sb-history-row").first()).toHaveClass(/unpushed/);
    // No drift, so the footer stays away.
    await expect(card.locator(".gc-away-foot")).toHaveCount(0);

    await card.locator(".gc-branchline").click();
    await expect(card.locator(".gc-search input")).toBeVisible();
    // The filter box must beat widgets.css's bare `input` rules on the cascade.
    const bg = await card.locator(".gc-search input").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("the overflow panel opens with the tiles, both meters and the tool key", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await mount(page, { chat_drain: { sessionId: "s1", tokens: 34, fiveHourPct: 50, weeklyPct: 12, messages: [] } });

    // The tally reaches the bar from the chat renderer, which the harness does
    // not drive; push one in so the mix strip has something to say.
    await page.evaluate(async () => {
      const { state } = await import("/views/sessions/state.ts");
      (state as unknown as { statusbar: { updateToolTally: (t: unknown) => void } }).statusbar.updateToolTally({
        byType: [{ tool: "Read", count: 12 }, { tool: "Bash", count: 9 }, { tool: "Grep", count: 6 }],
      });
    });

    await page.locator("#session-pane .sb-overflow-btn").click();
    const panel = page.locator(".sb-overflow-popover");
    await expect(panel.locator(".ov-tile")).toHaveCount(3);
    await expect(panel.locator(".ov-meter-fill")).toHaveCount(2);
    await expect(panel.locator(".ov-mixrow div")).toHaveCount(7);
    // Both meters share one colour: the panel exists to undo the hue sprawl.
    const fills = await panel.locator(".ov-meter-fill").evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    expect(new Set(fills).size).toBe(1);
  });
});
