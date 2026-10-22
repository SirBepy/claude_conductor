// Reviewed 2026-10-22: sessions-dom-wiring.ts passes the FAB a Code-mode opener; this spec asserts the favorites strip only, so its contract is unaffected.
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, capture } from "./harness";

// Holding Ctrl+Shift in a chat swaps the sidebar's chat numbers for the
// favourite project slots (Joe, 2026-10-05), floating just above the composer
// box with no hold delay (Joe, 2026-10-07).
// The hold timing and strip markup are unit-tested in
// tests/modifier-hint.test.mjs and tests/favorites-strip.test.mjs; this covers
// what only a browser can: real key events reaching the strip through the
// mounted view, and the strip landing in the composer of a live chat.
//
// asserts: src/shared/shortcuts.ts, src/shared/modifier-hint.ts, src/views/sessions/sessions-dom-wiring.ts, src/views/sessions/favorites-strip.ts, src/views/sessions/project-favorites.ts
// (ctrl+w's label/description changed in shortcuts.ts for todo-driven close-chat confirm work; unrelated to the favourites strip this spec covers)
// Reviewed 2026-10-20: shortcuts.ts gained a new "toggle-wrap-up-on-done" entry (ctrl+shift+w) and sessions-dom-wiring.ts registers its handler alongside the existing ones - both additive, no change to the ctrl+shift+1-9 favourites behavior this spec covers.
// (new-chat's suppressInInput flipped to false so Ctrl+N fires from inside an
// input/textarea too; unrelated to the Ctrl+Shift favourites strip this spec covers)
// (sessions-dom-wiring.ts split kbd-hint-active into an always-on display
// class plus a one-shot kbd-hint-entering class for the stagger-in keyframe,
// so a Ctrl+N jump mid-hold doesn't replay the entrance - this spec's
// Control-down check still sees the animation on the rising edge, unaffected)
// (close-chat row-removal fix touched wireDocumentListeners's cc:session-closed
// handler only - unrelated to the Ctrl+Shift favourites strip this spec covers)

const FAVORITES_KEY = "claude_companion_project_favorites";

function proj(name: string, emoji: string) {
  return {
    id: name, path: `C:/Projects/${name}`, name, parent_segment: null,
    avatar: { kind: "emoji", value: emoji }, automation_enabled: false, tokens_7d: 0, live: 0,
    any_automated: false, last_active_at: null,
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
  const shellHeight = (await page.locator("#session-pane .composer-shell").boundingBox())!.height;

  await page.keyboard.down("Control");
  await expect(list).toHaveClass(/kbd-hint-active/);
  // The chat numbers animate in rather than popping (Joe, 2026-10-07).
  const badgeAnim = await list.locator("li[data-kbd-hint]").first()
    .evaluate((li) => getComputedStyle(li, "::before").animationName);
  expect(badgeAnim).toBe("kbd-hint-in");

  await page.keyboard.down("Shift");
  await expect(list).not.toHaveClass(/kbd-hint-active/);

  const strip = page.locator(STRIP);
  await expect(strip).toBeVisible();
  const tiles = strip.locator(".pp-fav-slot");
  await expect(tiles).toHaveCount(9);
  await expect(tiles.nth(0).locator(".favorites-strip-name")).toHaveText("zng-app");
  await expect(tiles.nth(1)).toHaveClass(/is-empty/);

  // Floats above the composer box at its width, and never pushes it: the
  // shell keeps the height it had before the strip opened.
  const shell = page.locator("#session-pane .composer-shell");
  const stripBox = (await strip.boundingBox())!;
  const shellBox = (await shell.boundingBox())!;
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(shellBox.y + 1);
  expect(Math.abs(stripBox.width - shellBox.width)).toBeLessThan(3);
  expect(shellBox.height).toBeCloseTo(shellHeight, 0);
  await page.waitForTimeout(400);
  await capture(page.locator("#session-pane"), "favorites-strip-held");

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
