// asserts: src/views/sessions/position-dropdown.ts, src/views/sessions/sidebar-ctx-menu.ts, src/views/sessions/statusbar-popover-shell.ts, src/shared/chat/anchored-popover.ts, src/shared/kebab-menu.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// UI polish rule 16 (2026-11-17): a menu, popover or hover card stays inside the viewport from every
// anchor, a control at the screen's edge included. Seen: the chat heads' right-click menu ran off the
// left edge, because positionDropdown's right-align branch only had a right edge to hug.

const MIN = 60_000;
const since = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const chat = (id: string, name: string, n: number) =>
  sessionInstance({ session_id: id, name, pid: 100 + n, cwd: "C:/Projects/claude_usage_in_taskbar", started_at: since((20 - n) * MIN) });

const SESSIONS = [chat("a", "First chat", 1), chat("b", "Second chat", 2), chat("c", "Third chat", 3)];
const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: SESSIONS, get_active_sessions: SESSIONS,
  list_session_characters: {},
  get_project_icon: null,
  get_project_tech: null,
};

const head = (page: Page, id: string): Locator => page.locator(`#sessions-list li[data-session-id="${id}"]`);

async function mount(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await head(page, "a").waitFor();
}

interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
const rectOf = (loc: Locator): Promise<Rect> =>
  loc.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });

/** Pixel slack for sub-pixel rounding only; a menu 1px past an edge still fails the spec. */
function expectInside(r: Rect, vw: number, vh: number, what: string): void {
  expect(r.width, `${what}: has a size`).toBeGreaterThan(0);
  expect(r.left, `${what}: left edge`).toBeGreaterThanOrEqual(-0.5);
  expect(r.top, `${what}: top edge`).toBeGreaterThanOrEqual(-0.5);
  expect(r.right, `${what}: right edge`).toBeLessThanOrEqual(vw + 0.5);
  expect(r.bottom, `${what}: bottom edge`).toBeLessThanOrEqual(vh + 0.5);
}

test.describe("view-harness / menus stay inside the viewport", () => {
  test("a chat head's right-click menu opens fully on screen, wide and narrow", async ({ page }) => {
    for (const [vw, vh] of [[1280, 800], [700, 600]] as const) {
      await mount(page, vw, vh);
      for (const id of ["a", "b", "c"]) {
        await head(page, id).click({ button: "right" });
        const menu = page.locator(".session-ctx-menu");
        await menu.waitFor();
        // The head hugs the left edge, narrower than the menu: this is what pushed it off screen.
        expect((await rectOf(head(page, id))).right, `head ${id} is a narrow stack at the left edge`).toBeLessThan((await rectOf(menu)).width);
        // Shot before the assertion so a failing run still leaves the picture of the overflow.
        if (id === "a" && vw === 1280) await capture(page, "menu-viewport-chat-head");
        expectInside(await rectOf(menu), vw, vh, `chat head ${id} menu at ${vw}x${vh}`);
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
      }
    }
  });

  test("a chat head's menu stays on screen when the window is shorter than the menu", async ({ page }) => {
    await mount(page, 1280, 300);
    await head(page, "c").click({ button: "right" });
    const menu = page.locator(".session-ctx-menu");
    await menu.waitFor();
    expectInside(await rectOf(menu), 1280, 300, "chat head menu in a 300px window");
  });

  // positionDropdown has no UI of its own at an arbitrary edge, so drive it with real anchors parked
  // at every edge and corner, in both alignments.
  test("positionDropdown clamps every edge and corner, both alignments", async ({ page }) => {
    const vw = 800, vh = 600;
    await mount(page, vw, vh);
    const results = await page.evaluate(async ({ vw, vh }) => {
      const { positionDropdown } = await import(/* @vite-ignore */ "/views/sessions/position-dropdown.ts");
      const spots: Array<[string, number, number]> = [
        ["top-left", 0, 0], ["top-right", vw - 30, 0], ["bottom-left", 0, vh - 30], ["bottom-right", vw - 30, vh - 30],
        ["left-middle", 0, 280], ["right-middle", vw - 30, 280], ["top-middle", 380, 0], ["bottom-middle", 380, vh - 30],
      ];
      const out: Array<{ spot: string; align: string; l: number; t: number; r: number; b: number }> = [];
      for (const [spot, x, y] of spots) {
        for (const align of ["left", "right"] as const) {
          const anchor = document.createElement("button");
          anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:30px;height:30px`;
          const menu = document.createElement("div");
          menu.style.cssText = "position:fixed;width:240px;height:220px;background:#222";
          document.body.append(anchor, menu);
          positionDropdown(menu, anchor, { align });
          const r = menu.getBoundingClientRect();
          out.push({ spot, align, l: r.left, t: r.top, r: r.right, b: r.bottom });
          anchor.remove();
          menu.remove();
        }
      }
      return out;
    }, { vw, vh });
    expect(results).toHaveLength(16);
    for (const r of results) {
      expectInside({ left: r.l, top: r.t, right: r.r, bottom: r.b, width: r.r - r.l, height: r.b - r.t }, vw, vh, `${r.spot} ${r.align}`);
    }
  });

  test("a popover shell and an anchored popover flip or scroll at the bottom edge", async ({ page }) => {
    const vw = 800, vh = 500;
    await mount(page, vw, vh);
    const results = await page.evaluate(async ({ vw, vh }) => {
      const { positionPopoverShell } = await import(/* @vite-ignore */ "/views/sessions/statusbar-popover-shell.ts");
      const { openAnchoredPopover } = await import(/* @vite-ignore */ "/shared/chat/anchored-popover.ts");
      const out: Array<{ what: string; l: number; t: number; r: number; b: number }> = [];
      const spots: Array<[string, number, number]> = [["bottom-left", 0, vh - 30], ["bottom-right", vw - 30, vh - 30], ["top-right", vw - 30, 0]];
      for (const [spot, x, y] of spots) {
        const anchor = document.createElement("button");
        anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:30px;height:30px`;
        document.body.append(anchor);

        const shell = document.createElement("div");
        shell.style.cssText = "position:fixed;width:300px;height:340px;background:#222";
        document.body.append(shell);
        positionPopoverShell(shell, anchor);
        let r = shell.getBoundingClientRect();
        out.push({ what: `shell ${spot}`, l: r.left, t: r.top, r: r.right, b: r.bottom });
        shell.remove();

        // Taller than the room on either side: it has to scroll.
        const pop = document.createElement("div");
        pop.style.cssText = "position:fixed;width:260px;height:900px;background:#222";
        document.body.append(pop);
        const handle = openAnchoredPopover({ anchor, el: pop, onClose: () => pop.remove() });
        handle.reposition();
        r = pop.getBoundingClientRect();
        out.push({ what: `anchored ${spot}`, l: r.left, t: r.top, r: r.right, b: r.bottom });
        handle.close();
        anchor.remove();
      }
      return out;
    }, { vw, vh });
    expect(results).toHaveLength(6);
    for (const r of results) {
      expectInside({ left: r.l, top: r.t, right: r.r, bottom: r.b, width: r.r - r.l, height: r.b - r.t }, vw, vh, r.what);
    }
  });

  test("a kebab menu shifts off a screen edge", async ({ page }) => {
    const vw = 800, vh = 500;
    await mount(page, vw, vh);
    const results = await page.evaluate(async ({ vw, vh }) => {
      const { wireKebabMenu } = await import(/* @vite-ignore */ "/shared/kebab-menu.ts");
      const out: Array<{ what: string; l: number; t: number; r: number; b: number }> = [];
      const spots: Array<[string, number, number]> = [["left", 0, 200], ["right", vw - 30, 200], ["bottom-left", 0, vh - 30], ["bottom-right", vw - 30, vh - 30]];
      for (const [spot, x, y] of spots) {
        // The real stylesheet places `.menu-popover` right-aligned under its `.menu-anchor`; restate
        // that here so the spec does not depend on which view happened to load kebab-menu.css.
        const anchor = document.createElement("div");
        anchor.className = "menu-anchor";
        anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:30px;height:30px`;
        const btn = document.createElement("button");
        btn.style.cssText = "width:30px;height:30px";
        const menu = document.createElement("div");
        menu.className = "menu-popover hidden";
        menu.style.cssText = "position:absolute;top:calc(100% + 4px);right:0;width:200px;height:260px;background:#222";
        const item = document.createElement("button");
        item.className = "menu-item";
        item.textContent = "Item";
        menu.append(item);
        anchor.append(btn, menu);
        document.body.append(anchor);
        const dispose = wireKebabMenu(btn, menu);
        btn.click();
        const r = menu.getBoundingClientRect();
        out.push({ what: `kebab ${spot}`, l: r.left, t: r.top, r: r.right, b: r.bottom });
        dispose();
        anchor.remove();
      }
      return out;
    }, { vw, vh });
    expect(results).toHaveLength(4);
    for (const r of results) {
      expectInside({ left: r.l, top: r.t, right: r.r, bottom: r.b, width: r.r - r.l, height: r.b - r.t }, vw, vh, r.what);
    }
  });
});
