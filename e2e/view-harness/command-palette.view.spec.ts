// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// Reviewed 2026-11-10: PaletteSources gained optional placeholder, remember, match and decorate (the Answers card's History); with none of them set the palette behaves as before, and this spec passes.
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, capture } from "./harness";

// Ctrl+Shift+P opens a search box over every action (Joe, 2026-11-08). The
// ranking, recents and stage logic are unit-tested in tests/command-palette-*;
// this covers what only the booted app can: the real key combo reaching the
// boot-registered shortcut, rows built from the live chat list, and a jump into
// Settings landing on (and flashing) the named row.
//
// asserts: src/shared/boot.ts, src/shared/shortcuts.ts, src/views/command-palette/palette-ui.ts, src/views/command-palette/sources.ts, src/views/command-palette/settings-focus.ts

function proj(name: string, emoji: string) {
  return {
    id: name, path: `C:/Projects/${name}`, name, parent_segment: null,
    avatar: { kind: "emoji", value: emoji }, tokens_7d: 0, live: 0,
    any_automated: false, last_active_at: null,
    path_exists: true, worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
  };
}

const OVERLAY = ".cp-overlay";
const titles = (page: Page) => page.locator(".cp-row .cp-title").allTextContents();

async function mountChat(page: Page): Promise<void> {
  const a = sessionInstance({ session_id: "sess-a", name: "Fix the login bug" });
  const b = sessionInstance({ session_id: "sess-b", name: "Write release notes" });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_project_groups: [proj("zng-app", "⚡"), proj("countoff", "⏱️")],
      list_instances: [a, b],
      get_active_sessions: [a, b],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      get_recent_branches: [
        { name: "master", current: true, short_sha: "abc1234", upstream: null },
        { name: "feature/palette", current: false, short_sha: "def5678", upstream: null },
      ],
      get_git_dirty: ["src/a.ts", "src/b.ts"],
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-composer").waitFor();
}

test("Ctrl+Shift+P lists the open chat's actions, other chats, projects, shortcuts and settings", async ({ page }) => {
  await page.setViewportSize({ width: 1359, height: 900 });
  await mountChat(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator(OVERLAY)).toBeVisible();
  await expect(page.locator(`${OVERLAY} .cp-input`)).toBeFocused();

  const all = await titles(page);
  expect(all).toContain("Change account");
  expect(all).toContain("Switch branch");
  expect(all).toContain("Go to Home");
  await capture(page, "command-palette-open");

  await page.locator(`${OVERLAY} .cp-input`).fill("account");
  await expect(page.locator(".cp-row .cp-title").first()).toHaveText("Change account");
  await capture(page, "command-palette-search-account");

  await page.locator(`${OVERLAY} .cp-input`).fill("release");
  await expect(page.locator(".cp-row .cp-title")).toHaveText(["Write release notes"]);

  await page.locator(`${OVERLAY} .cp-input`).fill("new chat in zng");
  await expect(page.locator(".cp-row .cp-title").first()).toHaveText("New chat in zng-app");

  await page.keyboard.press("Escape");
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await expect(page.locator("#session-pane .session-composer")).toBeVisible();
});

test("Switch branch is a second step listing the repo's branches", async ({ page }) => {
  await page.setViewportSize({ width: 1359, height: 900 });
  await mountChat(page);
  await page.keyboard.press("Control+Shift+P");
  await page.locator(`${OVERLAY} .cp-input`).fill("switch branch");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cp-row .cp-title")).toHaveText(["master", "feature/palette"]);
  // The same two warnings Code mode's branch switcher shows before a checkout
  // (the harness's second chat shares this chat's folder).
  await expect(page.locator(".cp-note")).toHaveText([
    "Another Conductor session is active in this repo",
    "2 uncommitted files will come with you",
  ]);
  await capture(page, "command-palette-branch-stage");
  await page.keyboard.press("Backspace");
  await expect(page.locator(`${OVERLAY} .cp-input`)).toHaveAttribute("placeholder", /Search commands/);
  expect(await titles(page)).toContain("Switch branch");
});

test("a single setting opens its page and flashes the row", async ({ page }) => {
  await page.setViewportSize({ width: 1359, height: 900 });
  await mountChat(page);
  await page.keyboard.press("Control+Shift+P");
  await page.locator(`${OVERLAY} .cp-input`).fill("gaming mode");
  await expect(page.locator(".cp-row .cp-title").first()).toHaveText("Gaming mode");
  await page.keyboard.press("Enter");
  // The harness window is not the Chats window, so Settings opens as a router
  // view here rather than the popup; the row jump is the same either way.
  await expect(page.locator(".kit-row.palette-flash .kit-row-label")).toContainText("Gaming mode");
});

test("the desktop header has no three-dots button, and the palette carries the old menu's rows", async ({ page }) => {
  await page.setViewportSize({ width: 1359, height: 900 });
  await mountChat(page);
  await expect(page.locator("#viewMoreBtn")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator(OVERLAY)).toBeVisible();
  await expect(page.locator(".session-more-menu")).toHaveCount(0);
  const all = await titles(page);
  for (const t of ["Sleep when done", "Shutdown when done", "Hide chat", "Freeze chat", "Copy PID", "Open project in VS Code", "Change account"]) {
    expect(all, t).toContain(t);
  }
  await capture(page, "command-palette-old-menu-rows");
});

test("dragging the grip moves the palette, and it reopens where it was left", async ({ page }) => {
  await page.setViewportSize({ width: 1359, height: 900 });
  await mountChat(page);
  await page.keyboard.press("Control+Shift+P");
  const panel = page.locator(`${OVERLAY} .cp`);
  const grip = page.locator(`${OVERLAY} .cp-grip`);
  await expect(panel).toBeVisible();
  const home = (await panel.boundingBox())!;
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 380, g.y + g.height / 2 + 300, { steps: 8 });
  await page.mouse.up();
  const moved = (await panel.boundingBox())!;
  expect(Math.round(moved.x - home.x)).toBe(-380);
  expect(Math.round(moved.y - home.y)).toBe(300);
  await capture(page, "command-palette-dragged");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+P");
  const again = (await panel.boundingBox())!;
  expect(Math.round(again.x)).toBe(Math.round(moved.x));
  expect(Math.round(again.y)).toBe(Math.round(moved.y));

  await grip.dblclick();
  const reset = (await panel.boundingBox())!;
  expect(Math.round(reset.x)).toBe(Math.round(home.x));
});
