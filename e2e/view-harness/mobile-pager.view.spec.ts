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
      <div class="view-header"><h2>Chats</h2><span id="usage-dial-host"></span></div>
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

test("desktop keeps the side-by-side split and never shows the bar", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await mountPager(page);

  await expect(page.locator(".mobile-tabbar")).toBeHidden();
  // Above the breakpoint the rail obeys its own open/closed state again.
  await expect(page.locator("#preview-panel-host")).toBeHidden();
  await expect(page.locator(".view-sessions .view-header h2")).toBeVisible();
});
