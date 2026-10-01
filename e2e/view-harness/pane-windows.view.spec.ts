import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

const SCREENSHOT_DIR = shotDir();

// The chat pane's windows (Joe, 2026-10-01): Ask / Todos / Drafts / Preview as
// tabs in windows you drag by a title bar, resize from any edge, snap into a
// corner, dock beside the chat as a real split (both sides at once), and tear
// tabs out of or into. Real pointer input on the real FAB, not internal state.

const VIEWER = "sess-A";

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
  updated_at: "2026-10-01T08:00:00Z",
  seen_by_origin: true,
};

/** A full-bleed pane with a chat column we can measure, and the real FAB. */
async function mountPane(page: Page, invoke: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
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
      const fab = mod.mountFabDial(pane, { onDraft: () => {}, mountPreview: pv.mountPreviewTab });
      fab.setSessionScope(viewer, "/proj");
      (window as any).__fab = fab;
    },
    { draft: DRAFT, viewer: VIEWER },
  );
}

const win = (page: Page, panel: string) => page.locator(`.pw-window[data-active="${panel}"]`);

async function box(page: Page, panel: string) {
  const loc = win(page, panel);
  // Opening plays a short rise-in and drops glide; measure the settled window.
  // allSettled: a re-render can cancel the rise-in, which rejects `finished`.
  await loc.evaluate((el) => Promise.allSettled(el.getAnimations({ subtree: false }).map((a) => a.finished)));
  await page.waitForTimeout(280);
  const b = await loc.boundingBox();
  if (!b) throw new Error(`no ${panel} window`);
  return b;
}

async function openFromDial(page: Page, panel: string): Promise<void> {
  await page.locator(".fab-dial-fab").click();
  await page.locator(`[data-dial="${panel}"]`).click();
}

/** Drags a window by the empty stretch of its title bar. */
async function dragBar(page: Page, panel: string, to: { x: number; y: number }): Promise<void> {
  const grow = (await win(page, panel).locator(".pw-grow").boundingBox())!;
  await page.mouse.move(grow.x + grow.width / 2, grow.y + grow.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

const chatWidth = (page: Page) => page.locator("#chat-col").evaluate((el) => el.getBoundingClientRect().width);

test("a window opens centred with a title bar and its X top-right, and drags by the bar", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "drafts");
  const start = await box(page, "drafts");
  expect(Math.abs(start.x + start.width / 2 - 640)).toBeLessThanOrEqual(1);

  const x = (await win(page, "drafts").locator('[data-pw-act="close"]').boundingBox())!;
  expect(x.x + x.width).toBeGreaterThan(start.x + start.width - 12);
  expect(x.y).toBeLessThan(start.y + 36);

  const grow = (await win(page, "drafts").locator(".pw-grow").boundingBox())!;
  await dragBar(page, "drafts", { x: grow.x + grow.width / 2 - 150, y: grow.y + grow.height / 2 - 60 });
  const moved = await box(page, "drafts");
  expect(Math.round(moved.x)).toBe(Math.round(start.x - 150));
  expect(Math.round(moved.y)).toBe(Math.round(start.y - 60));
});

test("dropping on the right edge docks it as a split: the chat shrinks, and the divider resizes it", async ({ page }) => {
  await mountPane(page);
  const full = await chatWidth(page);
  await openFromDial(page, "drafts");
  await dragBar(page, "drafts", { x: 1278, y: 400 });

  const docked = await box(page, "drafts");
  expect(Math.round(docked.x + docked.width)).toBe(1280);
  expect(Math.round(docked.height)).toBe(800);
  expect(Math.round(await chatWidth(page))).toBe(Math.round(full - docked.width));

  // The divider is the window's inner edge.
  await page.mouse.move(docked.x, 400);
  await page.mouse.down();
  await page.mouse.move(docked.x - 100, 400, { steps: 5 });
  await page.mouse.up();
  const wider = await box(page, "drafts");
  expect(Math.round(wider.width)).toBe(Math.round(docked.width + 100));
  expect(Math.round(await chatWidth(page))).toBe(Math.round(full - wider.width));
});

test("both sides dock at once, Preview right and Drafts left, with the chat in between", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "preview");
  const preview = await box(page, "preview");
  expect(Math.round(preview.x + preview.width)).toBe(1280);

  await openFromDial(page, "drafts");
  await dragBar(page, "drafts", { x: 2, y: 400 });
  const drafts = await box(page, "drafts");
  expect(Math.round(drafts.x)).toBe(0);
  await expect(win(page, "preview")).toBeVisible();

  const chat = (await page.locator("#chat-col").boundingBox())!;
  expect(chat.x).toBeGreaterThanOrEqual(drafts.x + drafts.width - 1);
  expect(chat.x + chat.width).toBeLessThanOrEqual((await box(page, "preview")).x + 1);
  expect(chat.width).toBeGreaterThanOrEqual(360);
});

test("opening Preview from the dial loads the chat's latest snapshot", async ({ page }) => {
  const now = new Date().toISOString();
  const html = "<p id='hello'>hi from the snapshot</p>";
  await mountPane(page, {
    list_previews: [{ id: "snap-1", slug: "s", title: "S", source: "terminal", session_id: VIEWER, version: 2, created_at: now }],
    get_preview: { id: "snap-1", slug: "s", title: "S", html, source: "terminal", session_id: VIEWER, version: 2, created_at: now },
    render_preview_doc: "data:text/html;charset=utf-8," + encodeURIComponent(html),
  });
  await openFromDial(page, "preview");
  // The body fetches only when it comes into view, so a dial open that never
  // told it so left the window blank.
  await expect(win(page, "preview").locator("iframe.pv-iframe")).toHaveCount(1);
});

test("a corner drop parks a small window there, and pulling it off a dock floats it again", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "preview");
  await dragBar(page, "preview", { x: 1276, y: 796 });
  const corner = await box(page, "preview");
  expect(Math.round(corner.x + corner.width)).toBe(1272);
  expect(Math.round(corner.y + corner.height)).toBe(792);
  expect(corner.width).toBeLessThan(640);
  expect(await page.locator(".session-pane").evaluate((el) => getComputedStyle(el).paddingRight)).toBe("0px");
});

test("a tab dragged out of the bar becomes its own window, and dropped on another window's bar joins it", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "ask");
  await expect(page.locator(".fab-card:visible")).toHaveCount(1);

  const tab = (await win(page, "ask").locator('[data-spine="todos"]').boundingBox())!;
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
  await page.mouse.down();
  await page.mouse.move(300, 200, { steps: 10 });
  await expect(page.locator(".pw-tab-ghost")).toBeVisible();
  await page.mouse.up();

  await expect(page.locator(".fab-card:visible")).toHaveCount(2);
  await expect(win(page, "todos")).toBeVisible();
  await expect(win(page, "ask").locator('[data-spine="todos"]')).toHaveCount(0);

  // Back in: drag the Todos window by its bar onto Ask's bar, past its tabs.
  const askTabs = (await win(page, "ask").locator(".pw-tabs").boundingBox())!;
  await dragBar(page, "todos", { x: askTabs.x + askTabs.width + 30, y: askTabs.y + askTabs.height / 2 });
  await expect(page.locator(".fab-card:visible")).toHaveCount(1);
  await expect(page.locator('.fab-card:visible [data-spine="todos"]')).toHaveCount(1);
});

test("each chat keeps its own layout, and closing a window forgets it there", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "drafts");
  await dragBar(page, "drafts", { x: 1278, y: 400 });
  const docked = await box(page, "drafts");

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await expect(page.locator(".fab-card:visible")).toHaveCount(0);
  expect(await page.locator(".session-pane").evaluate((el) => getComputedStyle(el).paddingRight)).toBe("0px");

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  const back = await box(page, "drafts");
  expect(Math.round(back.x)).toBe(Math.round(docked.x));
  expect(Math.round(back.width)).toBe(Math.round(docked.width));

  await win(page, "drafts").locator('[data-pw-act="close"]').click();
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(page.locator(".fab-card:visible")).toHaveCount(0);
});

test("Revise opens its preset menu over the draft editor", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "drafts");
  await page.locator(".dr-card").click();
  await page.locator("[data-revise]").click();

  const items = page.locator("[data-revise-preset]");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toBeVisible();
  await expect(page.locator(".dr-rv-scope")).toHaveText("Whole draft");
  await page.screenshot({ path: `${SCREENSHOT_DIR}/pane-windows-revise.png` });
});
