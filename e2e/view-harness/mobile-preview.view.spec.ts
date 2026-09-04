import { test, expect, type Page } from "@playwright/test";
import { mountSessionsLayout, mountView } from "./harness";

// Joe, 2026-09-04: preview on a phone is a full-screen cover, opened from the
// chat pane's FAB dial and closed by the rail strip's X. It replaced a
// scroll-snap pager whose bottom tab bar existed only to be a swipe surface
// the preview iframe could not swallow.

const PHONE = { width: 390, height: 780 };

async function mountPhone(page: Page, opts: { fab?: boolean } = {}): Promise<void> {
  await mountView(page, { invoke: { list_previews: [] } });
  await mountSessionsLayout(page, { header: true, fab: opts.fab });
}

const railBox = (page: Page) => page.locator("#preview-panel-host").boundingBox();

test("the rail stays closed until something opens it", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page);

  await expect(page.locator("#preview-panel-host")).toBeHidden();
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
    return !!hit?.closest("#preview-panel-host");
  });
  expect(coversFab).toBe(true);
});

test("the FAB dial opens preview and the rail strip's X is the way back", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountPhone(page, { fab: true });

  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="preview"]').click();
  await expect(page.locator('[data-tab-body="preview"]')).toBeVisible();

  // The strip was hidden while the bottom bar owned the exit; without it the
  // cover would be a dead end.
  await expect(page.locator(".rail-strip")).toBeVisible();
  // Pop-out would open an OS window on the machine the phone is driving.
  await expect(page.locator('.rail-strip [data-act="popout"]')).toBeHidden();
  await page.locator('.rail-strip [data-act="close"]').click();

  await expect(page.locator("#preview-panel-host")).toBeHidden();
  await expect(page.locator(".fab-dial-fab")).toBeVisible();
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
  await page.locator('.rail-strip [data-act="close"]').click();

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
  await expect(page.locator(".session-header .meta")).toHaveText("zng-app");
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

test("desktop keeps the side-by-side split, and an open rail does not cover the chat", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await mountPhone(page, { fab: true });

  await expect(page.locator("#preview-panel-host")).toBeHidden();
  await expect(page.locator(".view-sessions .view-header h2")).toBeVisible();

  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="preview"]').click();

  const rail = (await railBox(page))!;
  const pane = (await page.locator(".session-pane").boundingBox())!;
  expect(rail.x).toBeGreaterThanOrEqual(pane.x + pane.width - 1);
});
