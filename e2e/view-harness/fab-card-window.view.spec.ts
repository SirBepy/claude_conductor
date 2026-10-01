import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

const SCREENSHOT_DIR = shotDir();

// The FAB card as a window inside the pane (Joe, 2026-10-01): it opens
// centred, the spine drags it, any edge or corner resizes it, and the Drafts
// editor's Revise menu opens over it. Real pointer input, not internal state.

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
          body: "Hey Bruno, quick heads up.\n\nThe backfill is slower than we estimated, so it misses Wednesday's freeze.\n\n- Backfill: about 60% done\n- New target: **Thursday**",
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

async function mountFab(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(
    async ({ draft, viewer }) => {
      localStorage.removeItem("cc.fabCard.size");
      localStorage.removeItem("cc.fabCard.chats");
      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) =>
        cmd === "list_message_drafts" ? Promise.resolve({ drafts: [draft] }) : passthrough(cmd, args);

      const pane = document.createElement("div");
      pane.style.cssText = "position:fixed;inset:0;z-index:1;background:var(--color-background)";
      document.body.appendChild(pane);
      const mod = await import("/views/sessions/fab-dial.ts");
      const fab = mod.mountFabDial(pane, { onDraft: () => {}, preview: null });
      fab.setSessionScope(viewer, "/proj");
      (window as any).__fab = fab;
    },
    { draft: DRAFT, viewer: VIEWER },
  );
}

async function box(page: Page) {
  // The open plays a short rise-in; measure the settled card, not a frame of it.
  await page.locator(".fab-card").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const b = await page.locator(".fab-card").boundingBox();
  if (!b) throw new Error("no card");
  return b;
}

test("the card opens centred, drags by its spine and resizes from a corner", async ({ page }) => {
  await mountFab(page);
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="drafts"]').click();

  const start = await box(page);
  expect(Math.abs(start.x + start.width / 2 - 640)).toBeLessThanOrEqual(1);
  expect(Math.abs(start.y + start.height / 2 - 400)).toBeLessThanOrEqual(1);

  // Drag by the spine's empty stretch, below its buttons.
  const grabX = start.x + 20;
  const grabY = start.y + start.height - 80;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX - 150, grabY - 60, { steps: 5 });
  await page.mouse.up();
  const moved = await box(page);
  expect(Math.round(moved.x)).toBe(Math.round(start.x - 150));
  expect(Math.round(moved.y)).toBe(Math.round(start.y - 60));
  expect(moved.width).toBe(start.width);

  // Grow from the bottom-right corner; the top-left stays put.
  await page.mouse.move(moved.x + moved.width - 3, moved.y + moved.height - 3);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width + 97, moved.y + moved.height + 37, { steps: 5 });
  await page.mouse.up();
  const grown = await box(page);
  expect(Math.round(grown.x)).toBe(Math.round(moved.x));
  expect(Math.round(grown.width)).toBe(Math.round(moved.width + 100));
  expect(Math.round(grown.height)).toBe(Math.round(moved.height + 40));

  // The new size is what the next launch opens at.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("cc.fabCard.size") ?? "null"));
  expect(saved).toEqual({ w: Math.round(grown.width), h: Math.round(grown.height) });
});

test("a chat keeps its card where it was left, and closing it forgets", async ({ page }) => {
  await mountFab(page);
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="todos"]').click();
  const start = await box(page);
  const grabX = start.x + 20;
  const grabY = start.y + start.height - 80;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 200, grabY - 120, { steps: 5 });
  await page.mouse.up();
  const parked = await box(page);

  // Away to a chat with no card, then back.
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await expect(page.locator(".fab-card")).toHaveCount(0);
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(page.locator(".fab-spine-btn.on")).toHaveAttribute("data-spine", "todos");
  const back = await box(page);
  expect(Math.round(back.x)).toBe(Math.round(parked.x));
  expect(Math.round(back.y)).toBe(Math.round(parked.y));

  await page.locator("[data-card-close]").click();
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(page.locator(".fab-card")).toHaveCount(0);
});

test("Revise opens its preset menu over the draft editor", async ({ page }) => {
  await mountFab(page);
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="drafts"]').click();
  await page.locator(".dr-card").click();
  await page.locator("[data-revise]").click();

  const items = page.locator("[data-revise-preset]");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toBeVisible();
  await expect(page.locator(".dr-rv-scope")).toHaveText("Whole draft");
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fab-card-window-revise.png` });
});
