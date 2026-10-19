import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

const SCREENSHOT_DIR = shotDir();

// The chat pane's windows (Joe, 2026-10-01): Ask / Todos / Drafts / Preview as
// windows you drag by a title bar, resize from any edge, snap into a corner,
// dock beside the chat as a real split (both sides at once), and tear tabs out
// of or into. Real pointer input on the real FAB, not internal state.
//
// Fresh-chat default (Joe, 2026-10-19): each panel opens into its OWN window,
// not bundled as tabs of one shared centred window. Ask and Drafts default to
// the bottom-right corner; Todos and Preview default to a full-height dock on
// the right, stacking as two windows in that column when both are open. A few
// gesture tests below merge two panels into one window on purpose, since the
// fresh default no longer hands them a shared tab bar to drag from.

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
  // Fresh relative to the run: the Drafts panel folds a draft untouched for a
  // week out of its "From this chat" list, and this spec clicks that card.
  updated_at: new Date().toISOString(),
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

/** Drags a tab out of its window's bar and drops it at `to`. */
async function dragTab(page: Page, panel: string, to: { x: number; y: number }): Promise<void> {
  const tab = (await page.locator(`.pw-window:visible [data-spine="${panel}"]`).boundingBox())!;
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

const chatWidth = (page: Page) => page.locator("#chat-col").evaluate((el) => el.getBoundingClientRect().width);

test("a window opens at the bottom-right corner with a title bar and its X top-right, and drags by the bar", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "drafts");
  const start = await box(page, "drafts");
  expect(Math.round(start.x + start.width)).toBe(1272);
  expect(Math.round(start.y + start.height)).toBe(792);

  const x = (await win(page, "drafts").locator('[data-pw-act="close"]').boundingBox())!;
  expect(x.x + x.width).toBeGreaterThan(start.x + start.width - 12);
  expect(x.y).toBeLessThan(start.y + 36);

  const grow = (await win(page, "drafts").locator(".pw-grow").boundingBox())!;
  await dragBar(page, "drafts", { x: grow.x + grow.width / 2 - 150, y: grow.y + grow.height / 2 - 60 });
  const moved = await box(page, "drafts");
  expect(Math.round(moved.x)).toBe(Math.round(start.x - 150));
  expect(Math.round(moved.y)).toBe(Math.round(start.y - 60));
});

test("fresh chat: Ask and Drafts each default to the bottom-right corner, in their own window", async ({ page }) => {
  // Each check gets its own fresh mount: a corner window sits right over the
  // FAB's own resting spot and hides it (manager.ts's syncFabCover), so a real
  // dial click can't open a second corner panel on top of a first one already
  // there - same as a real user, who would have to move or close it first.
  await mountPane(page);
  await openFromDial(page, "drafts");
  const drafts = await box(page, "drafts");
  expect(Math.round(drafts.x + drafts.width)).toBe(1272);
  expect(Math.round(drafts.y + drafts.height)).toBe(792);
  await expect(win(page, "drafts").locator("[data-spine]")).toHaveCount(0);

  await mountPane(page);
  await openFromDial(page, "ask");
  const ask = await box(page, "ask");
  expect(Math.round(ask.x + ask.width)).toBe(1272);
  expect(Math.round(ask.y + ask.height)).toBe(792);
  await expect(win(page, "ask").locator("[data-spine]")).toHaveCount(0);
});

test("fresh chat: Todos and Preview both default to a full-height right dock, stacking as two windows when both are open", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "todos");
  const todosAlone = await box(page, "todos");
  expect(Math.round(todosAlone.x + todosAlone.width)).toBe(1280);
  expect(Math.round(todosAlone.y)).toBe(0);
  expect(Math.round(todosAlone.height)).toBe(800);

  // Docking (unlike a corner snap) pushes the FAB left of the dock via
  // --pw-dock-r, so it stays reachable to open the second one.
  await openFromDial(page, "preview");
  await expect(page.locator(".pw-window:visible")).toHaveCount(2);
  const todosStacked = await box(page, "todos");
  const preview = await box(page, "preview");
  // Two separate windows sharing the dock column, not merged into tabs.
  await expect(win(page, "todos").locator("[data-spine]")).toHaveCount(0);
  await expect(win(page, "preview").locator("[data-spine]")).toHaveCount(0);
  expect(Math.round(todosStacked.x + todosStacked.width)).toBe(1280);
  expect(Math.round(preview.x + preview.width)).toBe(1280);
  expect(Math.round(todosStacked.height)).toBe(400);
  expect(Math.round(preview.height)).toBe(400);
  expect(Math.round(todosStacked.y)).toBe(0);
  expect(Math.round(preview.y)).toBe(400);
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

test("two solo corner windows merge into tabs when one is dropped on the other's bar", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "drafts");
  // Clear of the shared corner first, so Ask's own open doesn't just overlap it.
  await dragBar(page, "drafts", { x: 300, y: 300 });
  await box(page, "drafts");

  await openFromDial(page, "ask");
  await box(page, "ask");
  const draftsBar = (await win(page, "drafts").locator(".pw-bar").boundingBox())!;
  await dragBar(page, "ask", { x: draftsBar.x + draftsBar.width / 2, y: draftsBar.y + draftsBar.height / 2 });

  await expect(page.locator(".pw-window:visible")).toHaveCount(1);
  await expect(win(page, "ask").locator("[data-spine]")).toHaveCount(2);
  await expect(win(page, "ask").locator('[data-spine="drafts"]')).toHaveCount(1);
});

test("both sides dock at once, Preview right and Drafts left, with the chat in between", async ({ page }) => {
  await mountPane(page);
  // Preview's fresh default already docks it right; no tear-off needed.
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

test("a window dropped on a docked window's lower half stacks under it; the seam resizes both, and closing one gives the other the side", async ({ page }) => {
  await mountPane(page);
  // Preview's fresh default already docks it right; no tear-off needed.
  await openFromDial(page, "preview");
  await openFromDial(page, "ask");
  await box(page, "ask");
  await dragBar(page, "ask", { x: 1100, y: 600 });

  const top = await box(page, "preview");
  const bottom = await box(page, "ask");
  expect(Math.round(top.y)).toBe(0);
  expect(Math.round(top.height)).toBe(400);
  expect(Math.round(bottom.y)).toBe(400);
  expect(Math.round(bottom.y + bottom.height)).toBe(800);
  expect(Math.round(bottom.x)).toBe(Math.round(top.x));
  expect(Math.round(top.x + top.width)).toBe(1280);
  const chat = (await page.locator("#chat-col").boundingBox())!;
  expect(chat.x + chat.width).toBeLessThanOrEqual(top.x + 1);

  // The seam is the lower window's top edge.
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + 3);
  await page.mouse.down();
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y - 97, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await box(page, "preview")).height)).toBe(300);
  expect(Math.round((await box(page, "ask")).height)).toBe(500);

  await win(page, "preview").locator('[data-pw-act="close"]').click();
  const alone = await box(page, "ask");
  expect(Math.round(alone.y)).toBe(0);
  expect(Math.round(alone.height)).toBe(800);
});

test("a tab dropped on a docked window's upper half tears out and stacks above it", async ({ page }) => {
  await mountPane(page);
  // Preview's fresh default already docks it right, alone.
  await openFromDial(page, "preview");
  await box(page, "preview");

  // Merge Drafts and Ask first: the fresh default opens each solo, so there is
  // no tab to drag out until two windows are combined.
  await openFromDial(page, "drafts");
  await dragBar(page, "drafts", { x: 300, y: 300 });
  await openFromDial(page, "ask");
  await box(page, "ask");
  const draftsBar = (await win(page, "drafts").locator(".pw-bar").boundingBox())!;
  await dragBar(page, "ask", { x: draftsBar.x + draftsBar.width / 2, y: draftsBar.y + draftsBar.height / 2 });
  await expect(win(page, "ask").locator('[data-spine="drafts"]')).toHaveCount(1);

  await dragTab(page, "drafts", { x: 1100, y: 200 });

  await expect(page.locator(".pw-window:visible")).toHaveCount(3);
  const top = await box(page, "drafts");
  const bottom = await box(page, "preview");
  expect(Math.round(top.y)).toBe(0);
  expect(Math.round(top.height)).toBe(400);
  expect(Math.round(bottom.y)).toBe(400);
  await expect(win(page, "ask").locator('[data-spine="drafts"]')).toHaveCount(0);
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
  // Preview's fresh default already docks it right: this drag both floats it
  // off that dock AND parks it in the corner, in one gesture.
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
  // Merge Ask into Todos' dock first: the fresh default opens each solo, so
  // there is no tab to drag until two windows are combined. Todos (dock)
  // opens first - Ask's corner default would otherwise sit over the FAB and
  // hide it, like a real user, before Todos ever got a chance to open.
  await openFromDial(page, "todos");
  await openFromDial(page, "ask");
  await box(page, "todos");
  const todosBar = (await win(page, "todos").locator(".pw-bar").boundingBox())!;
  await dragBar(page, "ask", { x: todosBar.x + todosBar.width / 2, y: todosBar.y + todosBar.height / 2 });
  await expect(page.locator(".pw-window:visible")).toHaveCount(1);
  await expect(win(page, "ask").locator('[data-spine="todos"]')).toHaveCount(1);

  const tab = (await page.locator('.pw-window:visible [data-spine="todos"]').boundingBox())!;
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
  await page.mouse.down();
  await page.mouse.move(300, 200, { steps: 10 });
  await expect(page.locator(".pw-tab-ghost")).toBeVisible();
  await page.mouse.up();

  await expect(page.locator(".pw-window:visible")).toHaveCount(2);
  await expect(win(page, "todos")).toBeVisible();
  await expect(page.locator('.pw-window:visible [data-spine="todos"]')).toHaveCount(0);

  // Back in: drag the Todos window by its bar onto Ask's bar.
  const askBar = (await win(page, "ask").locator(".pw-bar").boundingBox())!;
  await dragBar(page, "todos", { x: askBar.x + askBar.width - 30, y: askBar.y + askBar.height / 2 });
  await expect(page.locator(".pw-window:visible")).toHaveCount(1);
  await expect(page.locator('.pw-window:visible [data-spine="todos"]')).toHaveCount(1);
});

test("each chat keeps its own layout, and closing a window forgets it there", async ({ page }) => {
  await mountPane(page);
  await openFromDial(page, "drafts");
  await dragBar(page, "drafts", { x: 1278, y: 400 });
  const docked = await box(page, "drafts");

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await expect(page.locator(".pw-window:visible")).toHaveCount(0);
  expect(await page.locator(".session-pane").evaluate((el) => getComputedStyle(el).paddingRight)).toBe("0px");

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  const back = await box(page, "drafts");
  expect(Math.round(back.x)).toBe(Math.round(docked.x));
  expect(Math.round(back.width)).toBe(Math.round(docked.width));

  await win(page, "drafts").locator('[data-pw-act="close"]').click();
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(page.locator(".pw-window:visible")).toHaveCount(0);
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
