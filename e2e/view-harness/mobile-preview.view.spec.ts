import { test, expect, type Page } from "@playwright/test";
import { mountSessionsLayout, mountView } from "./harness";

// Joe, 2026-09-04: preview on a phone is a full-screen cover, opened from the
// chat pane's FAB dial and closed by its window's X. It replaced a
// scroll-snap pager whose bottom tab bar existed only to be a swipe surface
// the preview iframe could not swallow.

const PHONE = { width: 390, height: 780 };

async function mountPhone(page: Page, opts: { fab?: boolean } = {}): Promise<void> {
  await mountView(page, { invoke: { list_previews: [] } });
  await mountSessionsLayout(page, { header: true, fab: opts.fab });
}

const PREVIEW = '.pw-window[data-active="preview"]';
const railBox = (page: Page) => page.locator(PREVIEW).boundingBox();

test("the rail stays closed until something opens it", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page);

  await expect(page.locator(PREVIEW)).toBeHidden();
  await expect(page.locator(".session-pane")).toBeVisible();
  // The bar and its snap pages are gone, not merely hidden.
  await expect(page.locator(".mobile-tabbar")).toHaveCount(0);
  const overflowX = await page.evaluate(
    () => getComputedStyle(document.querySelector(".sessions-layout")!).overflowX,
  );
  expect(overflowX).not.toBe("auto");
});

test("an open rail covers the whole phone screen", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });

  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="preview"]').click();

  const box = (await railBox(page))!;
  expect(Math.round(box.width)).toBe(PHONE.width);
  expect(Math.round(box.x)).toBe(0);

  // Hit-testing, not visibility: the FAB is still laid out under the cover, so
  // only elementFromPoint proves the rail's z-index actually cleared
  // .fab-dial-host's 30 in the shared stacking context.
  const coversFab = await page.evaluate(() => {
    const fab = document.querySelector<HTMLElement>(".fab-dial-fab")!.getBoundingClientRect();
    const hit = document.elementFromPoint(fab.x + fab.width / 2, fab.y + fab.height / 2);
    return !!hit?.closest('.pw-window[data-active="preview"]');
  });
  expect(coversFab).toBe(true);
});

test("the FAB dial opens preview and its window's X is the way back", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });

  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="preview"]').click();
  await expect(page.locator('[data-tab-body="preview"]')).toBeVisible();

  // Without the bar the cover would be a dead end.
  await expect(page.locator(`${PREVIEW} .pw-bar`)).toBeVisible();
  // Pop-out would open an OS window on the machine the phone is driving.
  await expect(page.locator(`${PREVIEW} [data-pw-act="popout"]`)).toBeHidden();
  await page.locator(`${PREVIEW} [data-pw-act="close"]`).click();

  await expect(page.locator(PREVIEW)).toBeHidden();
  await expect(page.locator(".fab-dial-fab")).toBeVisible();
});

async function openPreview(page: Page): Promise<void> {
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="preview"]').click();
  await expect(page.locator('[data-tab-body="preview"]')).toBeVisible();
}

// Joe, 2026-10-05: the bar moves to the bottom, in thumb reach, and a
// sideways swipe on it goes back to the chat.
test("the preview cover's bar sits at the bottom of the screen", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });
  await openPreview(page);

  const bar = (await page.locator(`${PREVIEW} .pw-bar`).boundingBox())!;
  const body = (await page.locator(`${PREVIEW} .fab-card-body`).boundingBox())!;
  expect(bar.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
  expect(Math.round(bar.y + bar.height)).toBe(PHONE.height);
});

test("a sideways swipe on the bar closes preview back to the chat", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });
  await openPreview(page);

  const bar = (await page.locator(`${PREVIEW} .pw-bar`).boundingBox())!;
  const y = bar.y + bar.height / 2;
  await page.mouse.move(60, y);
  await page.mouse.down();
  await page.mouse.move(260, y, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(PREVIEW)).toBeHidden();
  await expect(page.locator(".fab-dial-fab")).toBeVisible();
});

test("a short swipe on the bar snaps back and leaves preview open", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });
  await openPreview(page);

  const bar = (await page.locator(`${PREVIEW} .pw-bar`).boundingBox())!;
  const y = bar.y + bar.height / 2;
  await page.mouse.move(60, y);
  await page.mouse.down();
  await page.mouse.move(100, y, { steps: 4 });
  await page.mouse.up();

  await expect(page.locator(PREVIEW)).toBeVisible();
  const box = (await railBox(page))!;
  expect(Math.round(box.x)).toBe(0);
});

// Joe, 2026-10-05: no floating sheet or split on a phone - every panel gets
// the same full-screen cover as Preview.
test("a non-preview panel also opens as a full cover with its bar at the bottom", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="ask"]').click();

  const win = page.locator('.pw-window[data-active="ask"]');
  await expect(win).toBeVisible();
  const box = (await win.boundingBox())!;
  const pane = (await page.locator(".session-pane").boundingBox())!;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.width)).toBe(PHONE.width);
  expect(Math.round(box.y)).toBe(Math.round(pane.y));
  expect(Math.round(box.height)).toBe(Math.round(pane.height));
  const bar = (await win.locator(".pw-bar").boundingBox())!;
  expect(Math.round(bar.y + bar.height)).toBe(Math.round(box.y + box.height));
});

test("hardware back closes the preview cover", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });
  await openPreview(page);

  await page.evaluate(async () => {
    const back = await import("/shared/back-button.ts");
    back.handleBack();
  });
  await expect(page.locator(PREVIEW)).toBeHidden();
});

test("the transcript keeps its scroll position across a trip to preview", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });

  // Covering rather than swapping is the whole reason for position:absolute -
  // a display:none pane would come back scrolled to the top.
  await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>("#session-pane")!;
    const list = document.createElement("div");
    list.id = "spec-scroller";
    list.style.cssText = "flex:1;overflow-y:auto";
    list.innerHTML = "<div style='height:3000px'></div>";
    pane.appendChild(list);
    list.scrollTop = 900;
  });

  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="preview"]').click();
  await expect(page.locator('[data-tab-body="preview"]')).toBeVisible();
  await page.locator(`${PREVIEW} [data-pw-act="close"]`).click();

  const top = await page.evaluate(() => document.querySelector("#spec-scroller")!.scrollTop);
  expect(top).toBe(900);
});

test("the phone header drops the static Chats title and the quota dials", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page);

  await expect(page.locator(".view-sessions .view-header h2")).toBeHidden();
  await expect(page.locator("#usage-dial-host")).toBeHidden();
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
  await mountPhone(page);
  await withPaneHeader(page);

  await expect(page.locator(".session-header-lead > #sessionsBackBtn")).toBeVisible();
  await expect(page.locator(".session-header-trail > #viewMoreBtn")).toBeAttached();
  // The band it came from is now redundant, so it goes.
  await expect(page.locator(".view-sessions .view-header")).toBeHidden();
});

test("the character art and project name survive the merge", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page);
  await withPaneHeader(page);

  // Joe was explicit that these had to stay.
  await expect(page.locator(".session-header .session-header-avatar-wrap")).toBeVisible();
  // `.meta` also wraps the model/effort block (6fc6edd4), whose hidden `·`
  // separator still lands in textContent. The project name is `.meta-proj`.
  await expect(page.locator(".session-header .meta-proj")).toHaveText("zng-app");
  await expect(page.locator(".session-header .title")).toContainText("204 tiles swept");
});

test("the buttons go home when the viewport grows back to desktop", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page);
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

test("going back to the list puts the kebab back in the list's own header", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page);
  await page.evaluate(async () => {
    const merge = await import("/views/sessions/mobile-header-merge.ts");
    merge.initHeaderMerge(document.querySelector(".view-sessions")!);
  });
  await withPaneHeader(page);
  await expect(page.locator(".session-header-trail > #viewMoreBtn")).toBeAttached();

  // The pane header is only hidden in list mode, so without the re-home the
  // kebab stayed parked in it and the list header had no menu.
  await page.evaluate(() => document.querySelector(".view-sessions")!.setAttribute("data-mobile-pane", "list"));

  await expect(page.locator(".view-header > #viewMoreBtn")).toBeVisible();
  await expect(page.locator(".session-header-trail > #viewMoreBtn")).toHaveCount(0);
});

test("a failed merge degrades to the old layout rather than losing the back button", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page);
  // No pane header mounted, so the merge has nowhere to relocate into. The
  // :has() gate must therefore leave .view-header on screen.
  await page.evaluate(async () => {
    const merge = await import("/views/sessions/mobile-header-merge.ts");
    merge.applyHeaderMerge();
  });

  await expect(page.locator(".view-sessions .view-header")).toBeVisible();
  await expect(page.locator("#sessionsBackBtn")).toBeAttached();
});

test("desktop keeps the side-by-side split: docking Preview shrinks the chat instead of covering it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await mountPhone(page, { fab: true });

  await expect(page.locator(PREVIEW)).toBeHidden();
  await expect(page.locator(".view-sessions .view-header h2")).toBeVisible();

  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="preview"]').click();
  await page.locator(`${PREVIEW} [data-pw-act="dock"]`).click();
  await page.waitForTimeout(280);

  const rail = (await railBox(page))!;
  // The chat column is the pane's content box; the dock is its padding.
  const chatRight = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".session-pane")!;
    return pane.getBoundingClientRect().right - parseFloat(getComputedStyle(pane).paddingRight);
  });
  expect(chatRight).toBeLessThanOrEqual(rail.x + 1);
});
