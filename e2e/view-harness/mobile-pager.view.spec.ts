import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Joe, 2026-08-19: below 860px the docked rail was hidden outright, so a phone
// had no preview surface. It is now page 2 of a scroll-snap pager.
// Layout built by hand for the same reason as preview-panel-resize.view.spec.ts.

const PHONE = { width: 390, height: 780 };

async function mountPager(page: Page): Promise<void> {
  await mountView(page, { invoke: { list_previews: [] } });
  await page.evaluate(async () => {
    const pv = await import("/views/sessions/preview-panel.ts");
    const pager = await import("/views/sessions/mobile-pager.ts");
    document.querySelector("#preview-panel-host")?.remove();

    const view = document.createElement("div");
    view.className = "view view-sessions";
    view.setAttribute("data-mobile-pane", "chat");
    view.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;z-index:9999";
    view.innerHTML = `
      <div class="view-header">
        <button class="icon-btn sessions-back" id="sessionsBackBtn"><i class="ph ph-arrow-left"></i></button>
        <h2>Chats</h2>
        <span id="usage-dial-host"></span>
        <button class="icon-btn more-btn" id="viewMoreBtn"><i class="ph ph-dots-three-vertical"></i></button>
      </div>
      <div class="view-body sessions-layout" style="flex:1">
        <aside class="sessions-sidebar"></aside>
        <main class="session-pane" id="session-pane"></main>
        <div id="preview-panel-host" hidden></div>
      </div>
      <div id="mobile-tabbar-host"></div>`;
    document.body.appendChild(view);

    const host = view.querySelector<HTMLElement>("#preview-panel-host")!;
    const layout = view.querySelector<HTMLElement>(".sessions-layout")!;
    const controller = pv.renderPreview(host, { mode: "panel" });
    controller.setSessionScope("sess-1");
    pager.mountMobilePager(view.querySelector<HTMLElement>("#mobile-tabbar-host")!, layout, controller);
  });
}

const scrollLeft = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>(".sessions-layout")!.scrollLeft);

test("the rail is a reachable page at phone width, not hidden", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  // The `hidden` attribute is still set - CSS is what makes it a page here, so
  // asserting visibility rather than the attribute is the real check.
  await expect(page.locator("#preview-panel-host")).toBeVisible();

  const paneW = (await page.locator(".session-pane").boundingBox())!.width;
  const railW = (await page.locator("#preview-panel-host").boundingBox())!.width;
  expect(Math.round(paneW)).toBe(PHONE.width);
  expect(Math.round(railW)).toBe(PHONE.width);
});

test("the bottom bar pages between chat and the rail, and back again", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  expect(await scrollLeft(page)).toBe(0);

  await page.locator('.mtab[data-target="preview"]').click();
  await expect.poll(() => scrollLeft(page)).toBeGreaterThan(PHONE.width / 2);
  await expect(page.locator('[data-tab-body="preview"]')).toBeVisible();

  await page.locator('.mtab[data-target="chat"]').click();
  await expect.poll(() => scrollLeft(page)).toBe(0);
});

test("Todos and Preview are separate bar targets that both land on the rail", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  await page.locator('.mtab[data-target="todos"]').click();
  await expect.poll(() => scrollLeft(page)).toBeGreaterThan(PHONE.width / 2);
  await expect(page.locator('[data-tab-body="todos"]')).toBeVisible();
  await expect(page.locator('[data-tab-body="preview"]')).toBeHidden();

  await page.locator('.mtab[data-target="preview"]').click();
  await expect(page.locator('[data-tab-body="preview"]')).toBeVisible();
  await expect(page.locator('[data-tab-body="todos"]')).toBeHidden();
});

test("only the active tab shows its label, and every tap target clears 44px", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  const bar = page.locator(".mobile-tabbar");
  // V3: 30px of paint, so it must not creep back toward V1's 45px.
  const barH = (await bar.boundingBox())!.height;
  expect(barH).toBeLessThanOrEqual(34);

  await expect(page.locator('.mtab[data-target="chat"] .mtab-lbl')).toBeVisible();
  await expect(page.locator('.mtab[data-target="preview"] .mtab-lbl')).toBeHidden();

  // Paint is slim but the ::before hit area still has to reach the 44px floor
  // base.css enforces below 768px.
  const hit = await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('.mtab[data-target="preview"]')!;
    return parseFloat(getComputedStyle(btn, "::before").height);
  });
  expect(hit).toBeGreaterThanOrEqual(44);
});

test("the phone header drops the static Chats title and the quota dials", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  await expect(page.locator(".view-sessions .view-header h2")).toBeHidden();
  await expect(page.locator("#usage-dial-host")).toBeHidden();
});

// ── The swipe itself ──────────────────────────────────────────────────────
// The bar is one way to page; dragging is the other, and it is the one with no
// JS behind it. These drive the scroll container directly rather than trusting
// that `scroll-snap-type` in a stylesheet means the gesture works.

test("the layout is a horizontal snap container, and only horizontally", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  const style = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".sessions-layout")!;
    const cs = getComputedStyle(el);
    return {
      snap: cs.scrollSnapType,
      overflowX: cs.overflowX,
      // session-list.css sets `overflow: hidden`; the pager must beat it on x
      // WITHOUT opening y, or the whole chat column becomes scrollable.
      overflowY: cs.overflowY,
      scrollable: el.scrollWidth > el.clientWidth,
    };
  });

  expect(style.snap).toContain("x");
  expect(style.snap).toContain("mandatory");
  expect(style.overflowX).toBe("auto");
  expect(style.overflowY).toBe("hidden");
  expect(style.scrollable).toBe(true);
});

test("a horizontal swipe pages to the rail and snaps flush to it", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);
  expect(await scrollLeft(page)).toBe(0);

  // A trackpad/touch horizontal pan over the message list. Deliberately a
  // PARTIAL drag: mandatory snapping is what carries it the rest of the way.
  await page.mouse.move(PHONE.width / 2, 400);
  await page.mouse.wheel(PHONE.width * 0.6, 0);

  await expect.poll(() => scrollLeft(page)).toBe(PHONE.width);
  await expect(page.locator('.mtab[data-target="preview"]')).toHaveClass(/\bon\b/);
});

test("a short swipe falls back to the page it started on", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  await page.mouse.move(PHONE.width / 2, 400);
  await page.mouse.wheel(PHONE.width * 0.15, 0);

  await expect.poll(() => scrollLeft(page)).toBe(0);
  await expect(page.locator('.mtab[data-target="chat"]')).toHaveClass(/\bon\b/);
});

test("swiping back from the rail returns to chat and re-syncs the bar", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  await page.locator('.mtab[data-target="todos"]').click();
  await expect.poll(() => scrollLeft(page)).toBe(PHONE.width);
  await expect(page.locator('.mtab[data-target="todos"]')).toHaveClass(/\bon\b/);

  await page.mouse.move(PHONE.width / 2, 400);
  await page.mouse.wheel(-PHONE.width * 0.6, 0);

  await expect.poll(() => scrollLeft(page)).toBe(0);
  // The bar follows the gesture, not just its own clicks.
  await expect(page.locator('.mtab[data-target="chat"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('.mtab[data-target="todos"]')).not.toHaveClass(/\bon\b/);
});

test("the chip row keeps its own horizontal scroll instead of paging", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  // A .sb-row is its own overflow-x container, so a swipe that starts there
  // must scroll chips and leave the pager where it is.
  await page.evaluate(() => {
    const row = document.createElement("div");
    row.className = "sb-row";
    row.style.cssText = "overflow-x:auto;width:100%";
    // flex-basis, not width: .sb-row is a flex container, so a plain wide child
    // just gets shrunk back to fit and never overflows.
    row.innerHTML = "<span style='flex:0 0 900px'>chips</span>";
    document.querySelector("#session-pane")!.appendChild(row);
  });

  const rowBox = (await page.locator(".sb-row").boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.mouse.wheel(120, 0);

  await expect.poll(() => page.evaluate(() => document.querySelector(".sb-row")!.scrollLeft))
    .toBeGreaterThan(0);
  expect(await scrollLeft(page)).toBe(0);
});

// ── Dragging the bar ──────────────────────────────────────────────────────
// The pages rely on the browser's own scrolling, which the preview iframe
// swallows. The bar is our DOM on every page, so this is the swipe that has to
// work everywhere, including while the preview is showing.

/** Drags across the tab bar without ever leaving it. */
async function dragBar(page: Page, dx: number): Promise<void> {
  const bar = (await page.locator(".mobile-tabbar").boundingBox())!;
  const y = bar.y + bar.height / 2;
  const startX = dx < 0 ? bar.x + bar.width * 0.75 : bar.x + bar.width * 0.25;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  // Several steps: one jump under the slop threshold would read as a tap.
  for (let i = 1; i <= 6; i++) await page.mouse.move(startX + (dx * i) / 6, y);
  await page.mouse.up();
}

test("dragging the tab bar pages forward", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  await dragBar(page, -PHONE.width * 0.5);

  await expect.poll(() => scrollLeft(page)).toBe(PHONE.width);
  await expect(page.locator('.mtab[data-target="preview"]')).toHaveClass(/\bon\b/);
});

test("dragging the tab bar works from the preview page, where the iframe eats touch", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);
  await page.locator('.mtab[data-target="preview"]').click();
  await expect.poll(() => scrollLeft(page)).toBe(PHONE.width);

  await dragBar(page, PHONE.width * 0.5);

  await expect.poll(() => scrollLeft(page)).toBe(0);
  await expect(page.locator('.mtab[data-target="chat"]')).toHaveClass(/\bon\b/);
});

test("a drag under a third of a page springs back", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  await dragBar(page, -PHONE.width * 0.2);

  await expect.poll(() => scrollLeft(page)).toBe(0);
});

test("a drag does not also fire the tab it finished over", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);
  await page.locator('.mtab[data-target="todos"]').click();
  await expect.poll(() => scrollLeft(page)).toBe(PHONE.width);

  // Ends over Chat, but a drag must page rather than select. The rail tab it
  // lands back on should still be Todos, not Preview.
  await dragBar(page, PHONE.width * 0.5);
  await expect.poll(() => scrollLeft(page)).toBe(0);

  await dragBar(page, -PHONE.width * 0.5);
  await expect.poll(() => scrollLeft(page)).toBe(PHONE.width);
  await expect(page.locator('[data-tab-body="todos"]')).toBeVisible();
  await expect(page.locator('.mtab[data-target="todos"]')).toHaveClass(/\bon\b/);
});

test("a tap on a tab still selects it, and snapping is restored after a drag", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);

  await dragBar(page, -PHONE.width * 0.5);
  await expect.poll(() => scrollLeft(page)).toBe(PHONE.width);
  // Left disabled, the pages would stop snapping for the rest of the session.
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".sessions-layout")!.style.scrollSnapType))
    .toBe("");

  await page.locator('.mtab[data-target="chat"]').click();
  await expect.poll(() => scrollLeft(page)).toBe(0);
});

// ── Header merge (todo 702) ───────────────────────────────────────────────

/** Adds the pane header the merge relocates into, then runs the merge. */
async function withPaneHeader(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { SessionHeader } = await import("/views/sessions/session-header.ts");
    const merge = await import("/views/sessions/mobile-header-merge.ts");
    const header = new SessionHeader({ title: "204 tiles swept", meta: "zng-app" });
    document.querySelector("#session-pane")!.prepend(header.el);
    merge.applyHeaderMerge();
  });
}

test("the phone collapses to ONE header band, with back and the kebab in it", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);
  await withPaneHeader(page);

  await expect(page.locator(".session-header-lead > #sessionsBackBtn")).toBeVisible();
  await expect(page.locator(".session-header-trail > #viewMoreBtn")).toBeAttached();
  // The band it came from is now redundant, so it goes.
  await expect(page.locator(".view-sessions .view-header")).toBeHidden();
});

test("the character art and project name survive the merge", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);
  await withPaneHeader(page);

  // Joe was explicit that these had to stay.
  await expect(page.locator(".session-header .session-header-avatar-wrap")).toBeVisible();
  await expect(page.locator(".session-header .meta")).toHaveText("zng-app");
  await expect(page.locator(".session-header .title")).toContainText("204 tiles swept");
});

test("the buttons go home when the viewport grows back to desktop", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);
  await withPaneHeader(page);
  await expect(page.locator(".session-header-lead > #sessionsBackBtn")).toBeAttached();

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(async () => {
    const merge = await import("/views/sessions/mobile-header-merge.ts");
    merge.applyHeaderMerge();
  });

  await expect(page.locator(".view-header > #sessionsBackBtn")).toBeAttached();
  await expect(page.locator(".session-header-lead > #sessionsBackBtn")).toHaveCount(0);
  await expect(page.locator(".view-sessions .view-header")).toBeVisible();
});

test("a failed merge degrades to the old layout rather than losing the back button", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPager(page);
  // No pane header mounted, so the merge has nowhere to relocate into. The
  // :has() gate must therefore leave .view-header on screen.
  await page.evaluate(async () => {
    const merge = await import("/views/sessions/mobile-header-merge.ts");
    merge.applyHeaderMerge();
  });

  await expect(page.locator(".view-sessions .view-header")).toBeVisible();
  await expect(page.locator("#sessionsBackBtn")).toBeAttached();
});

test("desktop keeps the side-by-side split and never shows the bar", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await mountPager(page);

  await expect(page.locator(".mobile-tabbar")).toBeHidden();
  // Above the breakpoint the rail obeys its own open/closed state again.
  await expect(page.locator("#preview-panel-host")).toBeHidden();
  await expect(page.locator(".view-sessions .view-header h2")).toBeVisible();
});
