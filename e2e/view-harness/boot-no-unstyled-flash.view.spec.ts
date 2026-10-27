import { test, expect } from "@playwright/test";
// asserts: src/index.html, src/main.ts
import { mountView } from "./harness";

// index.html keeps the body hidden until main.ts has run, so no frame shows
// the app's markup before its stylesheets apply. The vite dev server (which
// this harness and `cargo tauri dev` both run on) delivers each view's
// stylesheet as a style tag only as its module evaluates, so without the gate
// the first frames are a bare list of side-menu links on a white page. Every
// frame is sampled, since the flash lasts a few frames and an end-state check
// cannot see it.

interface Frame { visibility: string; sidemenuPosition: string | null }

test.describe("view-harness / boot", () => {
  test("no frame shows the app's markup before its stylesheets are applied", async ({ page }) => {
    await page.addInitScript(() => {
      const frames: Frame[] = [];
      (window as unknown as { __bootFrames: Frame[] }).__bootFrames = frames;
      const sample = (): void => {
        if (document.body) {
          const menu = document.getElementById("sidemenu");
          frames.push({
            visibility: getComputedStyle(document.body).visibility,
            sidemenuPosition: menu ? getComputedStyle(menu).position : null,
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await mountView(page);
    await page.waitForTimeout(500);

    const frames = await page.evaluate(() => (window as unknown as { __bootFrames: Frame[] }).__bootFrames);
    // Sanity: the sampler saw the app shown and styled once ready. A hidden
    // frame is not required: a fast dev server can finish before the first sample.
    expect(frames.some((f) => f.visibility === "visible" && f.sidemenuPosition === "fixed")).toBe(true);
    const flashes = frames.filter((f) => f.visibility !== "hidden" && f.sidemenuPosition !== "fixed");
    expect(flashes).toEqual([]);
  });
});
