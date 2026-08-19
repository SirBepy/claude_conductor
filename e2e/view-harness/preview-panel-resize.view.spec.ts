import { test, expect, type Page } from "@playwright/test";
import { mountSessionsLayout, mountView } from "./harness";

// Regression for Joe, 2026-08-19: a dragged panel stored an absolute px width
// and the host is `flex-shrink: 0`, so narrowing the window collapsed
// `.session-pane` and pushed the close button past the right edge.

const MIN_CHAT_WIDTH = 360;

/** `seed` writes localStorage before any app script runs, so the panel reads it
 *  during construction the way a real reload would. */
async function boot(page: Page, seed: Record<string, string>): Promise<void> {
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, seed);
  await mountView(page, { invoke: { list_previews: [] } });
  await mountSessionsLayout(page, { openPanel: true });
  await expect(page.locator("#preview-panel-host")).toBeVisible();
}

async function widthOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  return box ? box.width : 0;
}

/** The panel's realised share of the space it splits with the chat pane. */
async function realisedRatio(page: Page): Promise<number> {
  const panel = await widthOf(page, "#preview-panel-host");
  const pane = await widthOf(page, ".session-pane");
  return panel / (panel + pane);
}

// 0.6 stays clear of the chat floor at both widths below, so this asserts the
// share is genuinely preserved rather than just re-clamped.
test("a dragged preview panel keeps its share of the split as the window resizes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page, { cc_preview_panel_ratio: "0.6" });

  const wide = await widthOf(page, "#preview-panel-host");
  expect(await realisedRatio(page)).toBeCloseTo(0.6, 1);

  await page.setViewportSize({ width: 1300, height: 900 });
  // ResizeObserver delivers on the frame after the viewport change.
  await expect.poll(() => widthOf(page, "#preview-panel-host")).toBeLessThan(wide);
  expect(await realisedRatio(page)).toBeCloseTo(0.6, 1);

  const narrow = (await page.locator("#preview-panel-host").boundingBox())!;
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(1300);
});

test("the close button stays inside the window after the window narrows", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page, { cc_preview_panel_ratio: "0.9" });

  await page.setViewportSize({ width: 900, height: 900 });
  const closeBtn = page.locator('#preview-panel-host [data-act="close"]');
  await expect.poll(async () => {
    const box = (await closeBtn.boundingBox())!;
    return box.x + box.width;
  }).toBeLessThanOrEqual(900);

  // The symptom was "I can't close it", so assert the click, not just geometry.
  await closeBtn.click();
  await expect(page.locator("#preview-panel-host")).toBeHidden();
});

// Joe's actual stored state when he reported this: an absolute width wider than
// the window he later shrank to. The legacy key is dropped on read, so it can
// never again pin a width the window no longer fits.
test("a legacy absolute saved width no longer pins the panel wider than the window", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await boot(page, { cc_preview_panel_width: "1400" });

  const box = (await page.locator("#preview-panel-host").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(900);
  // Falls all the way back to the even split, not to a clamped 1400.
  expect(await realisedRatio(page)).toBeCloseTo(0.5, 1);
  expect(await page.evaluate(() => localStorage.getItem("cc_preview_panel_width"))).toBeNull();
});

test("the chat pane keeps its floor no matter how greedy the saved share is", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await boot(page, { cc_preview_panel_ratio: "0.99" });

  await expect.poll(() => widthOf(page, ".session-pane")).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH);
});
