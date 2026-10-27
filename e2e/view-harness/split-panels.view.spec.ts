// asserts: src/views/sessions/split-panels/split.ts, src/views/sessions/split-panels/memory.ts, src/views/sessions/fab-dial.ts
import { test, expect, type Page } from "@playwright/test";
import { fireEvent, mountView } from "./harness";
import { shotDir } from "./shot-dir";

const SCREENSHOT_DIR = shotDir();

// The chat pane's panels on desktop (Joe, 2026-10-25): a split
// beside the chat with a draggable divider, and a narrow icon strip on the far
// right (Preview / Drafts / Todos / Ask) swapping which one fills it. Real
// pointer input on the real strip and FAB, not internal state.

const VIEWER = "sess-A";
const STRIP_W = 44;

const DRAFT = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  topic: "Deploy slip",
  brief: "",
  receipts: [],
  variants: [
    {
      recipient: "Bruno",
      handle_n: 2,
      current: 1,
      versions: [
        {
          n: 1,
          body: "Hey Bruno, quick heads up.\n\nThe backfill is slower than we estimated, so it misses Wednesday's freeze.",
          author: "ai",
          note: "",
          created_at: "2026-10-01T08:00:00Z",
        },
      ],
    },
  ],
  state: "needs-you",
  origin_session_id: VIEWER,
  origin_label: "deploy",
  created_at: "2026-10-01T08:00:00Z",
  // Fresh relative to the run: a draft untouched for a week stops counting
  // as open, and both the strip's count and the card clicks below need it open.
  updated_at: new Date().toISOString(),
  seen_by_origin: true,
};

/** A full-bleed pane with a chat column we can measure, and the real FAB. */
async function mountPane(page: Page, invoke: Record<string, unknown> = {}, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await mountView(page, { invoke: { list_slash_commands: [], list_previews: [], ...invoke } });
  await page.evaluate(
    async ({ draft, viewer }) => {
      localStorage.clear();
      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) =>
        cmd === "list_message_drafts" ? Promise.resolve({ drafts: [draft] }) : passthrough(cmd, args);

      const pane = document.createElement("main");
      pane.className = "session-pane";
      pane.style.cssText = "position:fixed;inset:0;z-index:1;box-sizing:border-box";
      pane.innerHTML = `<div id="chat-col" style="flex:1"></div>`;
      document.body.appendChild(pane);
      const pv = await import("/views/sessions/preview-panel.ts");
      const mod = await import("/views/sessions/fab-dial.ts");
      const fab = mod.mountFabDial(pane, { onDraft: () => {}, onCode: () => {}, mountPreview: pv.mountPreviewTab });
      fab.setSessionScope(viewer, "/proj");
      (window as any).__fab = fab;
    },
    { draft: DRAFT, viewer: VIEWER },
  );
}

const panel = (page: Page) => page.locator(".sp-panel");
const tab = (page: Page, k: string) => page.locator(`.sp-tab[data-sp-k="${k}"]`);
const chatWidth = (page: Page) => page.locator("#chat-col").evaluate((el) => el.getBoundingClientRect().width);

test("at rest only the strip shows, Code then Preview / Drafts / Todos / Ask top to bottom, and the chat keeps the rest", async ({ page }) => {
  await mountPane(page);
  await expect(panel(page)).toBeHidden();
  const keys = await page.locator(".sp-tab").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.spK ?? "code"));
  expect(keys).toEqual(["code", "preview", "drafts", "todos", "ask"]);
  expect(Math.round(await chatWidth(page))).toBe(1280 - STRIP_W);
});

test("Drafts' open count shows quietly on its icon before it is opened", async ({ page }) => {
  await mountPane(page);
  await expect(tab(page, "drafts").locator(".sp-count")).toHaveText("1");
  await expect(tab(page, "todos").locator(".sp-count")).toHaveCount(0);
});

test("a chat switch clears the previous chat's Drafts count until the new one's fetch lands", async ({ page }) => {
  await mountPane(page);
  await expect(tab(page, "drafts").locator(".sp-count")).toHaveText("1");
  await page.evaluate(() => {
    // The next chat's fetch never resolves, so only the switch itself can clear the count.
    const tauri = (window as any).__TAURI__;
    const passthrough = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: any) =>
      cmd === "list_message_drafts" ? new Promise(() => {}) : passthrough(cmd, args);
    (window as any).__fab.setSessionScope("sess-B", "/proj");
  });
  await expect(tab(page, "drafts").locator(".sp-count")).toHaveCount(0);
});

test("a strip icon fills the split beside the chat; the same icon or the X closes it", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-active", "drafts");
  await expect(tab(page, "drafts")).toHaveAttribute("aria-pressed", "true");

  const p = (await panel(page).boundingBox())!;
  const chat = await chatWidth(page);
  // Half and half by default: the chat ends where the divider starts.
  expect(Math.round(p.x + p.width)).toBe(1280 - STRIP_W);
  expect(Math.abs(chat - p.width)).toBeLessThanOrEqual(1);
  expect(Math.round(chat + 6 + p.width + STRIP_W)).toBe(1280);

  await tab(page, "drafts").click();
  await expect(panel(page)).toBeHidden();
  expect(Math.round(await chatWidth(page))).toBe(1280 - STRIP_W);

  await tab(page, "todos").click();
  await panel(page).locator('[data-sp-act="close"]').click();
  await expect(panel(page)).toBeHidden();
});

test("another icon swaps the panel in place, one at a time", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  await tab(page, "todos").click();
  await expect(panel(page)).toHaveAttribute("data-active", "todos");
  await expect(page.locator(".sp-pane:visible")).toHaveCount(1);
  await expect(page.locator('.sp-pane[data-panel="todos"]')).toBeVisible();
  await expect(tab(page, "drafts")).toHaveAttribute("aria-pressed", "false");
});

test("dragging the divider resizes the split, and the width holds across a close and reopen", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  const before = await chatWidth(page);
  const div = (await page.locator(".sp-divider").boundingBox())!;
  await page.mouse.move(div.x + div.width / 2, div.y + 200);
  await page.mouse.down();
  await page.mouse.move(div.x - 150, div.y + 200, { steps: 8 });
  await page.mouse.up();
  const after = await chatWidth(page);
  expect(Math.round(before - after)).toBeGreaterThan(140);

  await tab(page, "drafts").click();
  await tab(page, "drafts").click();
  expect(Math.round(await chatWidth(page))).toBe(Math.round(after));
});

test("the divider stops where the chat would drop under its minimum", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  const div = (await page.locator(".sp-divider").boundingBox())!;
  await page.mouse.move(div.x + div.width / 2, div.y + 200);
  await page.mouse.down();
  await page.mouse.move(40, div.y + 200, { steps: 8 });
  await page.mouse.up();
  expect(Math.round(await chatWidth(page))).toBe(420);
});

test("each chat keeps its own panel, and closing it forgets it there", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await expect(panel(page)).toBeHidden();
  expect(await page.locator(".session-pane").evaluate((el) => getComputedStyle(el).paddingRight)).toBe(`${STRIP_W}px`);

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(panel(page)).toHaveAttribute("data-active", "drafts");
  await expect(panel(page)).toBeVisible();

  await tab(page, "drafts").click();
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(panel(page)).toBeHidden();
});

test("no chat, no strip and no width taken", async ({ page }) => {
  await mountPane(page);
  await page.evaluate(() => (window as any).__fab.setSessionScope(null, null));
  await expect(page.locator(".sp-strip")).toHaveCount(0);
  expect(await page.locator(".session-pane").evaluate((el) => getComputedStyle(el).paddingRight)).toBe("0px");
});

test("too narrow for a split, the panel covers the chat instead of squeezing it", async ({ page }) => {
  // Above the phone breakpoint (768px), so the desktop split is mounted.
  await mountPane(page, {}, 780);
  await tab(page, "drafts").click();
  await expect(panel(page)).toHaveAttribute("data-overlay", "");
  await expect(page.locator(".sp-divider")).toBeHidden();
  expect(Math.round(await chatWidth(page))).toBe(780 - STRIP_W);
  const p = (await panel(page).boundingBox())!;
  expect(Math.round(p.x)).toBe(0);
});

test("Escape closes the split", async ({ page }) => {
  await mountPane(page);
  await tab(page, "todos").click();
  await page.mouse.click(200, 400);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
});

const SNAP_NOW = new Date().toISOString();
const SNAP_HTML = "<p id='hello'>hi from the snapshot</p>";
const PREVIEW_MOCKS = {
  list_previews: [{ id: "snap-1", slug: "s", title: "S", source: "terminal", session_id: VIEWER, version: 2, created_at: SNAP_NOW }],
  get_preview: { id: "snap-1", slug: "s", title: "S", html: SNAP_HTML, source: "terminal", session_id: VIEWER, version: 2, created_at: SNAP_NOW },
  render_preview_doc: "data:text/html;charset=utf-8," + encodeURIComponent(SNAP_HTML),
};

test("opening Preview from the strip loads the chat's latest snapshot, under one header row", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "preview").click();
  // The body fetches only when it comes into view, so an open that never
  // told it so left the panel blank.
  await expect(panel(page).locator("iframe.pv-iframe")).toHaveCount(1);
  // The split's close/pop-out sit in Preview's own head row, not a second one above it.
  const head = (await panel(page).locator(".pv-head").boundingBox())!;
  const close = (await panel(page).locator('[data-sp-act="close"]').boundingBox())!;
  const popout = panel(page).locator('[data-sp-act="popout"]');
  await expect(popout).toBeVisible();
  expect(close.y).toBeGreaterThanOrEqual(head.y);
  expect(close.y + close.height).toBeLessThanOrEqual(head.y + head.height);
  const kebab = (await panel(page).locator('.pv-head [data-act="more"]').boundingBox())!;
  expect(kebab.x + kebab.width).toBeLessThanOrEqual((await popout.boundingBox())!.x);
});

test("a push while another panel fills the split leaves that panel and dots Preview's icon", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "drafts").click();
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(0);
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);
  await expect(panel(page)).toHaveAttribute("data-active", "drafts");

  // Shown once, the dot is spent.
  await tab(page, "preview").click();
  await expect(panel(page)).toHaveAttribute("data-active", "preview");
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(0);
});

const scopeTo = (page: Page, sid: string) =>
  page.evaluate((s) => (window as any).__fab.setSessionScope(s, "/proj"), sid);

test("a Preview pushed behind Drafts stays pending across chat switches", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "drafts").click();
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);

  for (let i = 0; i < 2; i++) {
    await scopeTo(page, "sess-B");
    await scopeTo(page, VIEWER);
    await expect(panel(page)).toHaveAttribute("data-active", "drafts");
    await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);
  }
});

test("a Preview pushed to a background chat is still pending on the second return to it", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "drafts").click();
  await scopeTo(page, "sess-B");
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);

  for (let i = 0; i < 2; i++) {
    await scopeTo(page, VIEWER);
    await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);
    await scopeTo(page, "sess-B");
  }
});

test("a push with the split closed opens Preview in it", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);
  await expect(panel(page)).toHaveAttribute("data-active", "preview");
  await expect(panel(page)).toBeVisible();
});

test("Revise opens its preset menu over the draft editor", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  await page.locator(".dr-card").click();
  await page.locator("[data-revise]").click();

  const items = page.locator("[data-revise-preset]");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toBeVisible();
  await expect(page.locator(".dr-rv-scope")).toHaveText("Whole draft");
  await page.screenshot({ path: `${SCREENSHOT_DIR}/split-panels-revise.png` });
});
