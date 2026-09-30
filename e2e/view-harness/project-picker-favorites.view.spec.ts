import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Favourite slots 1-9 in the Pick project modal (Joe, 2026-09-26): rail A,
// placement P4 (inline in the footer). The slot algebra is unit-tested in
// tests/project-favorites.test.mjs; THIS covers the parts only a real browser
// can answer - that the rail renders in the footer, that a number key resolves
// through the picker and skips the Location step, and that the drag gestures
// (assign / move / remove) actually reach the model.
//
// asserts: src/views/sessions/project-picker.ts, src/views/sessions/project-favorites.ts

const FAVORITES_KEY = "claude_companion_project_favorites";

function proj(id: string, name: string, path: string, extra: Record<string, unknown> = {}) {
  return {
    id, path, name, parent_segment: null,
    avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
    any_remote: false, any_automated: false, last_active_at: null,
    path_exists: true, worktrees: [],
    last_worktree_path: null, last_start_folder_rel: null,
    ...extra,
  };
}

const PROJECTS = [
  proj("p-zng", "zng-app", "C:/Projects/zng-app"),
  proj("p-cnt", "countoff", "C:/Projects/countoff"),
  proj("p-fib", "fibo", "C:/Projects/fibo"),
];

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: PROJECTS,
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: [],
  get_settings: {},
};

/** Seeds localStorage BEFORE the picker reads it. readFavorites() runs once
 *  when the modal opens, so writing after mount would be ignored. */
async function openPicker(page: Page, seed?: (string | null)[]): Promise<void> {
  await mountView(page, { invoke: BASE_INVOKE });
  if (seed) {
    await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)),
      [FAVORITES_KEY, seed] as const);
  } else {
    await page.evaluate((k) => localStorage.removeItem(k), FAVORITES_KEY);
  }
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.waitForSelector(".pp-fav-slot");
}

async function readSlots(page: Page): Promise<(string | null)[]> {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), FAVORITES_KEY);
}

/** Drives the gesture with real mouse input, so it exercises the same pointer
 *  events a person produces. The rail used to be HTML5 drag-and-drop, which
 *  synthetic DragEvents "passed" while the real app (Tauri's native file-drop
 *  handler owns the webview's drop target) never delivered a drop at all.
 *
 *  `row:<name>` picks a list row by its visible project name. */
async function center(page: Page, sel: string): Promise<{ x: number; y: number }> {
  const loc = sel.startsWith("row:")
    ? page.locator(".project-picker-row", { has: page.locator(".project-picker-name", { hasText: sel.slice(4) }) })
    : page.locator(sel);
  const box = await loc.boundingBox();
  if (!box) throw new Error(`drag endpoint missing: ${sel}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function pointerDrag(page: Page, fromSel: string, to: string | { x: number; y: number }): Promise<void> {
  const a = await center(page, fromSel);
  const b = typeof to === "string" ? await center(page, to) : to;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

test.describe("view-harness / project picker favourites rail", () => {
  test("renders nine slots inside the footer, not as a row of its own", async ({ page }) => {
    await openPicker(page);

    await expect(page.locator(".pp-fav-slot")).toHaveCount(9);
    await expect(page.locator(".modal-footer .pp-fav-rail")).toHaveCount(1);
    // All empty on a fresh install, and the numerals read 1..9 in order.
    await expect(page.locator(".pp-fav-slot.is-empty")).toHaveCount(9);
    expect(await page.locator(".pp-fav-slot .pp-num").allTextContents())
      .toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  test("the old New project / Open in new folder buttons are gone from the footer", async ({ page }) => {
    await openPicker(page);

    const footer = page.locator(".project-picker-modal .modal-footer");
    await expect(footer).not.toContainText("New project");
    await expect(footer).not.toContainText("Open in new folder");
    await expect(footer.locator("button", { hasText: "Cancel" })).toHaveCount(1);
  });

  test("dragging a list row onto a slot assigns it and persists", async ({ page }) => {
    await openPicker(page);

    await pointerDrag(page, "row:countoff", '[data-slot="2"]');

    expect(await readSlots(page)).toEqual(
      [null, null, "C:/Projects/countoff", null, null, null, null, null, null],
    );
    await expect(page.locator('[data-slot="2"]')).not.toHaveClass(/is-empty/);
    // The row now advertises which key opens it.
    await expect(page.locator('.project-picker-row:has-text("countoff") .pp-row-fav')).toHaveText("3");
  });

  test("dragging a tile onto an occupied slot SWAPS, destroying neither", async ({ page }) => {
    await openPicker(page, ["C:/Projects/zng-app", "C:/Projects/countoff", null, null, null, null, null, null, null]);

    await pointerDrag(page, '[data-slot="0"]', '[data-slot="1"]');

    const slots = await readSlots(page);
    expect(slots[0]).toBe("C:/Projects/countoff");
    expect(slots[1]).toBe("C:/Projects/zng-app");
  });

  test("dragging a tile onto an empty slot moves it", async ({ page }) => {
    await openPicker(page, ["C:/Projects/zng-app", null, null, null, null, null, null, null, null]);

    await pointerDrag(page, '[data-slot="0"]', '[data-slot="4"]');

    const slots = await readSlots(page);
    expect(slots[0]).toBeNull();
    expect(slots[4]).toBe("C:/Projects/zng-app");
  });

  test("dragging a tile off the rail removes that favourite", async ({ page }) => {
    await openPicker(page, ["C:/Projects/zng-app", "C:/Projects/countoff", null, null, null, null, null, null, null]);

    await pointerDrag(page, '[data-slot="0"]', "#project-picker-search");

    const slots = await readSlots(page);
    expect(slots[0]).toBeNull();
    // The neighbour keeps its own number rather than sliding up into slot 1.
    expect(slots[1]).toBe("C:/Projects/countoff");
  });

  test("a project cannot hold two numbers at once", async ({ page }) => {
    await openPicker(page, ["C:/Projects/zng-app", null, null, null, null, null, null, null, null]);

    await pointerDrag(page, "row:zng-app", '[data-slot="5"]');

    const slots = await readSlots(page);
    expect(slots[0]).toBeNull();
    expect(slots[5]).toBe("C:/Projects/zng-app");
    expect(slots.filter((s) => s === "C:/Projects/zng-app")).toHaveLength(1);
  });

  test("a drag released back over its own row does not open that project", async ({ page }) => {
    await openPicker(page);

    const start = await center(page, "row:fibo");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y - 40, { steps: 4 });
    await page.mouse.move(start.x, start.y, { steps: 4 });
    await page.mouse.up();

    await expect(page.locator(".project-picker-modal")).toHaveCount(1);
    expect(await readSlots(page)).toBeNull();
  });

  test("a drag in flight paints its target slot, and a plain click still opens a row", async ({ page }) => {
    await openPicker(page);

    const a = await center(page, "row:countoff");
    const b = await center(page, '[data-slot="3"]');
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await expect(page.locator('[data-slot="3"]')).toHaveClass(/is-target/);
    await expect(page.locator(".pp-drag-ghost")).toContainText("countoff");
    await page.mouse.up();
    await expect(page.locator(".pp-drag-ghost")).toHaveCount(0);

    await page.locator(".project-picker-row", { hasText: "zng-app" }).click();
    await expect(page.locator(".project-picker-modal")).toHaveCount(0);
  });

  test("ctrl+number opens the slot, skipping the Location step", async ({ page }) => {
    // fibo has a worktree AND more than one CLAUDE.md scope, so the normal
    // click path would stop at the Location card. The shortcut must not.
    await mountView(page, {
      invoke: {
        ...BASE_INVOKE,
        list_project_groups: [
          proj("p-fib", "fibo", "C:/Projects/fibo", {
            worktrees: [{ path: "C:/Projects/fibo/wt-a", name: "wt-a", tokens_7d: 0, live: 0, last_active_at: null, path_exists: true }],
          }),
        ],
        list_claude_md_scopes: [
          { rel_path: "", label: "Repo root", nested: false },
          { rel_path: "packages/app", label: "packages/app", nested: true },
        ],
      },
    });
    await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)),
      [FAVORITES_KEY, ["C:/Projects/fibo", null, null, null, null, null, null, null, null]] as const);
    await page.evaluate(() => {
      void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
    });
    await page.waitForSelector(".pp-fav-slot");

    await page.locator("#project-picker-search").press("Control+1");

    await expect(page.locator(".project-picker-modal")).toHaveCount(0);
    await expect(page.locator(".loc-picker-modal, .loc-field")).toHaveCount(0);
  });

  test("a bare number key is always a literal character, even once the search box has text", async ({ page }) => {
    await openPicker(page, ["C:/Projects/zng-app", null, null, null, null, null, null, null, null]);

    const search = page.locator("#project-picker-search");
    await search.fill("fib");
    await search.press("1");

    // Still in the picker, and the digit typed through - the shortcut needs ctrl/cmd now.
    await expect(page.locator(".project-picker-modal")).toHaveCount(1);
    await expect(search).toHaveValue("fib1");
  });

  test("a bare number key types through even when that slot is filled - ctrl is required to trigger it", async ({ page }) => {
    await openPicker(page, [null, null, null, null, null, null, "C:/Projects/countoff", null, null]);

    const search = page.locator("#project-picker-search");
    await search.press("7");

    await expect(page.locator(".project-picker-modal")).toHaveCount(1);
    await expect(search).toHaveValue("7");
  });

  test("a bare number key whose slot is empty types through instead of being swallowed", async ({ page }) => {
    await openPicker(page);

    const search = page.locator("#project-picker-search");
    await search.press("7");

    await expect(page.locator(".project-picker-modal")).toHaveCount(1);
    await expect(search).toHaveValue("7");
  });

  test("a slot pointing at a project that is gone keeps its number and is inert to ctrl+number too", async ({ page }) => {
    await openPicker(page, ["C:/Projects/deleted-long-ago", null, null, null, null, null, null, null, null]);

    const slot = page.locator('[data-slot="0"]');
    await expect(slot).toHaveClass(/is-unresolved/);
    await expect(page.locator(".pp-fav-slot")).toHaveCount(9);

    await page.locator("#project-picker-search").press("Control+1");
    await expect(page.locator(".project-picker-modal")).toHaveCount(1);
  });
});
