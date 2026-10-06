import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, capture } from "./harness";

// Holding Ctrl+Shift in a chat swaps the sidebar's chat numbers for the
// favourite project slots, shown inside the composer box (Joe, 2026-10-05).
// The hold timing and strip markup are unit-tested in
// tests/modifier-hint.test.mjs and tests/favorites-strip.test.mjs; this covers
// what only a browser can: real key events reaching the strip through the
// mounted view, and the strip landing in the composer of a live chat.
//
// asserts: src/shared/shortcuts.ts, src/shared/modifier-hint.ts, src/views/sessions/sessions-dom-wiring.ts, src/views/sessions/favorites-strip.ts, src/views/sessions/project-favorites.ts

const FAVORITES_KEY = "claude_companion_project_favorites";

function proj(name: string, emoji: string) {
  return {
    id: name, path: `C:/Projects/${name}`, name, parent_segment: null,
    avatar: { kind: "emoji", value: emoji }, automation_enabled: false, tokens_7d: 0, live: 0,
    any_remote: false, any_automated: false, last_active_at: null,
    path_exists: true, worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
  };
}

const PROJECTS = [proj("zng-app", "⚡"), proj("countoff", "⏱️"), proj("fibo", "🌀")];
const STRIP = "#session-pane .composer-shell > .favorites-strip";

async function mountChat(page: Page, favorites: (string | null)[]): Promise<void> {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [FAVORITES_KEY, favorites] as const);
  const instance = sessionInstance();
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_project_groups: PROJECTS,
      list_instances: [instance],
      get_active_sessions: [instance],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-composer").waitFor();
}

const SEEDED = ["C:/Projects/zng-app", null, "C:/Projects/countoff", "C:/Projects/fibo", null, null, null, null, null];

test("a still Ctrl+Shift hold hides the chat numbers and shows the favourites in the composer", async ({ page }) => {
  await page.setViewportSize({ width: 1359, height: 900 });
  await mountChat(page, SEEDED);
  const list = page.locator("#sessions-list");

  await page.keyboard.down("Control");
  await expect(list).toHaveClass(/kbd-hint-active/);

  await page.keyboard.down("Shift");
  await expect(list).not.toHaveClass(/kbd-hint-active/);
  await expect(page.locator(STRIP)).toHaveCount(0);

  const strip = page.locator(STRIP);
  await expect(strip).toBeVisible();
  const tiles = strip.locator(".pp-fav-slot");
  await expect(tiles).toHaveCount(9);
  await expect(tiles.nth(0).locator(".favorites-strip-name")).toHaveText("zng-app");
  await expect(tiles.nth(1)).toHaveClass(/is-empty/);

  // Sits above the input, inside the same box.
  const stripBox = (await strip.boundingBox())!;
  const inputBox = (await page.locator("#session-pane .session-composer").boundingBox())!;
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(inputBox.y + 1);
  expect(Math.abs(stripBox.width - inputBox.width)).toBeLessThan(2);
  await capture(page.locator("#session-pane .composer-shell"), "favorites-strip-held");

  await page.keyboard.up("Shift");
  await expect(page.locator(STRIP)).toHaveCount(0);
  await expect(list).toHaveClass(/kbd-hint-active/);
  await page.keyboard.up("Control");
  await expect(list).not.toHaveClass(/kbd-hint-active/);
});

test("Ctrl+Shift+Arrow word selection never shows the strip", async ({ page }) => {
  await mountChat(page, SEEDED);
  await page.locator("#session-pane .session-composer .composer-textarea").fill("one two three");
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(700);
  await expect(page.locator(STRIP)).toHaveCount(0);
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
});

test("no favourites set means no strip at all", async ({ page }) => {
  await mountChat(page, [null, null, null, null, null, null, null, null, null]);
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.waitForTimeout(700);
  await expect(page.locator(STRIP)).toHaveCount(0);
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
});
