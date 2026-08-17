import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression (commit ecc058fb): a sidebar row tooltip shown by a mobile tap
// (mouseover compat event, no mouseout ever fires) used to stay stuck open
// forever. row-tooltip.ts now dismisses it on the next outside pointerdown
// and via a 3s auto-hide backstop.

async function setupRow(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const { attachRowTooltips } = await import("/shared/row-tooltip.ts");
    const root = document.createElement("div");
    root.innerHTML = '<span class="session-row-project" data-tip="Full chat title">Row</span>';
    document.body.appendChild(root);
    attachRowTooltips(root);
  });
}

function fireTap(page: import("@playwright/test").Page, selector: string): Promise<void> {
  // Mirrors mobile's touch-to-mouse compat order: pointerdown fires before
  // the synthetic mouseover row-tooltip.ts listens on.
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  }, selector);
}

test.describe("view-harness / sidebar row tooltip tap dismiss (todo 471)", () => {
  test("shows on tap and dismisses on the next outside tap", async ({ page }) => {
    await mountView(page);
    await setupRow(page);

    const tip = page.locator(".cc-row-tip");
    await fireTap(page, ".session-row-project");
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText("Full chat title");

    await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await expect(tip).toBeHidden();
  });

  test("auto-hides on its own after ~3s with no further interaction", async ({ page }) => {
    await page.clock.install();
    await mountView(page);
    await setupRow(page);

    const tip = page.locator(".cc-row-tip");
    await fireTap(page, ".session-row-project");
    await expect(tip).toBeVisible();

    await page.clock.runFor(3100);
    await expect(tip).toBeHidden();
  });
});
