import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { mountView } from "./harness";

// asserts: src/shared/chat/image-zoom-pan.ts
// Phone image viewer: two fingers pinch-zoom the image (it used to only know
// mouse wheel + tap, so a pinch re-anchored a one-finger pan instead), and a
// pinch never ends as a tap that toggles zoom or closes the lightbox.

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

async function openImage(page: Page): Promise<void> {
  await mountView(page);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#c0f";
    ctx.fillRect(0, 0, 300, 300);
    const base64 = canvas.toDataURL("image/png").split(",")[1]!;
    const lightbox = await import("/shared/chat/lightbox.ts");
    lightbox.openLightbox({ type: "image", mime: "image/png", base64, filename: "a.png" });
  });
  await expect(page.locator(".lightbox-content--image img")).toBeVisible();
}

async function imgCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator(".lightbox-content--image img").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function scaleOf(page: Page): Promise<number> {
  const t = await page.locator(".lightbox-content--image img").evaluate((el) => (el as HTMLElement).style.transform);
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? "1");
}

type Pt = { x: number; y: number };
async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", pts: Pt[]): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
}

async function pinch(cdp: CDPSession, from: [Pt, Pt], to: [Pt, Pt]): Promise<void> {
  await touch(cdp, "touchStart", [from[0]]);
  await touch(cdp, "touchStart", from);
  for (let i = 1; i <= 6; i++) {
    const f = i / 6;
    const lerp = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    await touch(cdp, "touchMove", [lerp(from[0], to[0]), lerp(from[1], to[1])]);
  }
  await touch(cdp, "touchEnd", []);
}

test.describe("view-harness / lightbox pinch-to-zoom on a phone", () => {
  test("spreading two fingers zooms in and leaves the lightbox open", async ({ page }) => {
    await openImage(page);
    const c = await imgCentre(page);
    const cdp = await page.context().newCDPSession(page);

    await pinch(cdp, [{ x: c.x - 20, y: c.y }, { x: c.x + 20, y: c.y }], [{ x: c.x - 80, y: c.y }, { x: c.x + 80, y: c.y }]);

    expect(await scaleOf(page)).toBeGreaterThan(3);
    await page.waitForTimeout(400);
    await expect(page.locator(".lightbox-overlay")).toBeVisible();
    expect(await scaleOf(page)).toBeGreaterThan(3);
  });

  test("a second finger landing beside the image still pinches", async ({ page }) => {
    await openImage(page);
    const c = await imgCentre(page);
    const box = (await page.locator(".lightbox-content--image img").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const outside = { x: c.x, y: box.y + box.height + 40 };

    await pinch(cdp, [{ x: c.x, y: c.y }, outside], [{ x: c.x, y: c.y - 60 }, { x: outside.x, y: outside.y + 60 }]);

    expect(await scaleOf(page)).toBeGreaterThan(1.5);
    await page.waitForTimeout(400);
    await expect(page.locator(".lightbox-overlay")).toBeVisible();
  });

  test("pinching back in to fit glides back to centre", async ({ page }) => {
    await openImage(page);
    const c = await imgCentre(page);
    const cdp = await page.context().newCDPSession(page);
    await pinch(cdp, [{ x: c.x - 20, y: c.y }, { x: c.x + 20, y: c.y }], [{ x: c.x + 40, y: c.y + 60 }, { x: c.x + 120, y: c.y + 60 }]);
    expect(await scaleOf(page)).toBeGreaterThan(1.5);

    await pinch(cdp, [{ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y }], [{ x: c.x - 5, y: c.y }, { x: c.x + 5, y: c.y }]);
    await expect.poll(() => page.locator(".lightbox-content--image img").evaluate((el) => (el as HTMLElement).style.transform))
      .toBe("translate(0px, 0px) scale(1)");
  });

  test("a single tap on the image still toggles zoom", async ({ page }) => {
    await openImage(page);
    const c = await imgCentre(page);
    await page.touchscreen.tap(c.x, c.y);
    await expect.poll(() => scaleOf(page)).toBe(2.5);
    await expect(page.locator(".lightbox-overlay")).toBeVisible();
  });

  test("a tap on the backdrop beside the image still closes it", async ({ page }) => {
    await openImage(page);
    const box = (await page.locator(".lightbox-content--image img").boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height + 40);
    await expect(page.locator(".lightbox-overlay")).toHaveCount(0);
  });
});
