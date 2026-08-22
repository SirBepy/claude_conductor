import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Todo 526: prove every image entry point lands on the unified
// chat-image-gallery overlay rather than the old single-image lightbox.
// Distinct 240x150 PNGs per image on purpose, so an entry point that resolved
// its start index by matching bytes (todo 740) can't false-green it.
const VIOLET = "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABQ0lEQVR42u3SQQ0AQAgDQYTi6PzyBQFngJBpRkGz0WaHFi4wQZsJ2kzQZoI2QZsJ2kzQZoI2E7QJ2kzQZoI2E7SZoE3QZoI2E7SZoM0EbYI2E7SZoM0EbfYH/bLgDEEjaBA0CBoEjaBB0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgSNoL2AoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0ggZBg6BB0CBoBA2CBkGDoEHQCBoEDYIGQYOgETQIGgQNggZBI2gQNAgaBA2CRtAgaBA0CBoEjaBB0CBoEDSC9gKCBkGDoEHQCBoEDYIGQYOgETQIGrYYrlt1AWLq60YAAAAASUVORK5CYII=";
const GREEN = "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABQ0lEQVR42u3SAQ0AQAgDMVxi7MXgDgS8AUK6VMFy0WaHFi4wQZsJ2kzQZoI2QZsJ2kzQZoI2E7QJ2kzQZoI2E7SZoE3QZoI2E7SZoM0EbYI2E7SZoM0EbfYHnfXgDEEjaBA0CBoEjaBB0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgSNoL2AoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0ggZBg6BB0CBoBA2CBkGDoEHQCBoEDYIGQYOgETQIGgQNggZBI2gQNAgaBA2CRtAgaBA0CBoEjaBB0CBoEDSC9gKCBkGDoEHQCBoEDYIGQYOgETQIGrYYQ57mjBlTxfgAAAAASUVORK5CYII=";
const AMBER = "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABQ0lEQVR42u3SQQ0AQAgDQbQh9FzyBgFngJBpRkGz0WaHFi4wQZsJ2kzQZoI2QZsJ2kzQZoI2E7QJ2kzQZoI2E7SZoE3QZoI2E7SZoM0EbYI2E7SZoM0EbfYHXS/hDEEjaBA0CBoEjaBB0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgSNoL2AoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0ggZBg6BB0CBoBA2CBkGDoEHQCBoEDYIGQYOgETQIGgQNggZBI2gQNAgaBA2CRtAgaBA0CBoEjaBB0CBoEDSC9gKCBkGDoEHQCBoEDYIGQYOgETQIGrYYDF3LRcBto9MAAAAASUVORK5CYII=";
const TEAL = "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABQ0lEQVR42u3SQQ0AQAgDQWRh/nzxAwFngJBpRkGz0WaHFi4wQZsJ2kzQZoI2QZsJ2kzQZoI2E7QJ2kzQZoI2E7SZoE3QZoI2E7SZoM0EbYI2E7SZoM0EbfYHna/gDEEjaBA0CBoEjaBB0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgSNoL2AoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0ggZBg6BB0CBoBA2CBkGDoEHQCBoEDYIGQYOgETQIGgQNggZBI2gQNAgaBA2CRtAgaBA0CBoEjaBB0CBoEDSC9gKCBkGDoEHQCBoEDYIGQYOgETQIGrYY7cfIagkvw+QAAAAASUVORK5CYII=";
const ROSE = "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABQ0lEQVR42u3SQQ0AQAgDQTQj7pTxBwFngJBpRkGz0WaHFi4wQZsJ2kzQZoI2QZsJ2kzQZoI2E7QJ2kzQZoI2E7SZoE3QZoI2E7SZoM0EbYI2E7SZoM0EbfYHXfngDEEjaBA0CBoEjaBB0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgSNoL2AoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0ggZBg6BB0CBoBA2CBkGDoEHQCBoEDYIGQYOgETQIGgQNggZBI2gQNAgaBA2CRtAgaBA0CBoEjaBB0CBoEDSC9gKCBkGDoEHQCBoEDYIGQYOgETQIGrYYB5FNhBjOuVsAAAAASUVORK5CYII=";
const LIME = "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABQ0lEQVR42u3SAQ0AQAgDMcSi80VhAAS8AUK6VMFy0WaHFi4wQZsJ2kzQZoI2QZsJ2kzQZoI2E7QJ2kzQZoI2E7SZoE3QZoI2E7SZoM0EbYI2E7SZoM0EbfYH/SrhDEEjaBA0CBoEjaBB0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgSNoL2AoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0ggZBg6BB0CBoBA2CBkGDoEHQCBoEDYIGQYOgETQIGgQNggZBI2gQNAgaBA2CRtAgaBA0CBoEjaBB0CBoEDSC9gKCBkGDoEHQCBoEDYIGQYOgETQIGrYYRDqjyOUgi4oAAAAASUVORK5CYII=";

const DESKTOP = { width: 1400, height: 900 };

function userMsg(text: string, image?: string): unknown {
  const content: unknown[] = [{ type: "text", text }];
  if (image) content.push({ type: "image", mime: "image/png", data: image });
  return { type: "user_message", content, timestamp: 0, remote_echo: false, is_meta: false, author_session_id: null };
}

function shot(id: string, description: string, data: string): unknown[] {
  return [
    { type: "tool_use", tool_name: "Bash", input: { command: "capture.ps1", description }, id, timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: id, output: { type: "image", mime: "image/png", data }, is_error: false, timestamp: 0, output_truncated: false },
  ];
}

function assistantMsg(text: string): unknown {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: false, timestamp: 0 };
}

// 4 image-bearing turns -> 7 images: 1 attachment, 4 screenshots, 2 inline
// blocks. GREEN's bytes are unique; AMBER's repeat screenshot #1's.
function transcript() {
  const events: unknown[] = [
    userMsg("Here is the crash screen <file:C:/shots/crash-report.png::crash-report.png>", GREEN),
    assistantMsg("Got it, reproducing now."),
    userMsg("Now capture the app window twice."),
    ...shot("tu1", "capture app window", AMBER),
    ...shot("tu2", "capture the tray", TEAL),
    assistantMsg("Captured both."),
    userMsg("Diff it against the baseline."),
    ...shot("tu3", "diff overlay", ROSE),
    assistantMsg("Diffed."),
    userMsg("Same shot again for reference.", AMBER),
    ...shot("tu4", "final capture", LIME),
    assistantMsg("Done."),
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountChat(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: transcript(),
      read_attachment: { mime: "image/png", base64: VIOLET },
      // "images" is not in DEFAULT_ROWS, so the chip has to be pinned on.
      get_settings: { theme: "void", statuslineRows: [["images", "model", "messages"]] },
    },
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .screenshot-thumb").first().waitFor();
  await page.locator("#session-pane .msg.user .sent-attachment-thumb:not(.screenshot-thumb)").first().waitFor();
}

const gallery = (page: Page) => page.locator(".chat-image-gallery-overlay");
const plainLightbox = (page: Page) => page.locator(".lightbox-overlay:not(.chat-image-gallery-overlay)");

/** The unified gallery is up, the old lightbox is not, and the stage really
 *  decoded a PNG (a broken src still lays out, so check naturalWidth). */
async function expectUnifiedGallery(page: Page, counter: string, railLabel: string): Promise<void> {
  await expect(gallery(page)).toBeVisible();
  await expect(plainLightbox(page)).toHaveCount(0);
  await expect(page.locator(".gallery-total-counter")).toHaveText(counter);
  await expect(page.locator(".gallery-rail-chip-label")).toHaveText(railLabel);
  const stage = page.locator(".chat-image-gallery-overlay .screenshot-gallery-stage img");
  await expect(stage).toBeVisible();
  expect(await stage.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
}

interface Box { x: number; y: number; right: number; bottom: number }
function overlaps(a: Box, b: Box): boolean {
  return !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y);
}

/** The drawer animates max-height, so shoot it only once nothing is clipped. */
async function railSettled(page: Page): Promise<void> {
  const drawer = page.locator(".gallery-rail-drawer");
  await expect
    .poll(() => drawer.evaluate((el) => el.clientHeight - el.scrollHeight))
    .toBeGreaterThanOrEqual(0);
}

interface OverlayBoxes { drawer: Box; prev: Box; next: Box; counter: Box; close: Box }

async function overlayBoxes(page: Page): Promise<OverlayBoxes> {
  return page.evaluate(() => {
    const box = (sel: string): Box => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    };
    return {
      drawer: box(".gallery-rail-drawer"),
      prev: box(".screenshot-gallery-nav--prev"),
      next: box(".screenshot-gallery-nav--next"),
      counter: box(".gallery-total-counter"),
      close: box(".lightbox-close"),
    };
  });
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("attachment thumb opens the unified gallery", async ({ page }) => {
    await mountChat(page);
    await page.locator("#session-pane .msg.user .sent-attachment-thumb:not(.screenshot-thumb)").first().click();
    await expectUnifiedGallery(page, "1 of 7", "Here is the crash screen");
    await expect(page.locator(".gallery-rail-chip-count")).toHaveText("1/2");
    await capture(gallery(page), "gallery-from-attachment");
  });

  test("inline block image opens the unified gallery at its own slot", async ({ page }) => {
    await mountChat(page);
    const inline = page.locator("#session-pane .msg.user img.block.image");
    await expect(inline).toHaveCount(2);

    // Repeats screenshot #1's bytes, still lands on its own slot.
    await inline.nth(1).click();
    await expectUnifiedGallery(page, "7 of 7", "Same shot again for reference.");
    await capture(gallery(page), "gallery-from-inline-image");
    await page.keyboard.press("Escape");
    await expect(gallery(page)).toHaveCount(0);

    // Regression, todo 740: these bytes appear nowhere else in the transcript,
    // which used to drop the click through to the old single-image lightbox.
    await inline.nth(0).click();
    await expectUnifiedGallery(page, "2 of 7", "Here is the crash screen");
    await capture(gallery(page), "gallery-from-inline-image-unique-bytes");
  });

  test("screenshot-row thumb opens the unified gallery at that shot", async ({ page }) => {
    await mountChat(page);
    const thumbs = page.locator("#session-pane .screenshot-thumb");
    await expect(thumbs).toHaveCount(4);
    await thumbs.nth(1).click();
    await expectUnifiedGallery(page, "4 of 7", "Now capture the app window twice.");
    await expect(page.locator(".gallery-rail-chip-count")).toHaveText("2/2");
    await capture(gallery(page), "gallery-from-screenshot-row");
  });

  test("rail peeks across a turn boundary, pins on chip click, and jumps", async ({ page }) => {
    await mountChat(page);
    await page.locator("#session-pane .msg.user .sent-attachment-thumb:not(.screenshot-thumb)").first().click();
    await expectUnifiedGallery(page, "1 of 7", "Here is the crash screen");

    const rail = page.locator(".gallery-rail");
    await expect(rail).not.toHaveClass(/\bopen\b/);
    // Image 2 is turn 1's own inline block, so only step 2 crosses a turn.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".gallery-total-counter")).toHaveText("2 of 7");
    await expect(rail).not.toHaveClass(/\bopen\b/);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".gallery-total-counter")).toHaveText("3 of 7");
    await expect(rail).toHaveClass(/\bopen\b/);
    await expect(rail).toHaveClass(/\bpeek\b/);
    await expect(page.locator(".gallery-rail-entry.current .gallery-rail-entry-name"))
      .toHaveText("Now capture the app window twice.");
    await railSettled(page);
    await capture(gallery(page), "gallery-rail-peek");

    await expect(rail).not.toHaveClass(/\bopen\b/, { timeout: 5000 });

    await page.locator(".gallery-rail-chip").click();
    await expect(page.locator(".gallery-rail-chip")).toHaveClass(/pinned/);
    const drawer = page.locator(".gallery-rail-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.locator(".gallery-rail-entry")).toHaveCount(4);
    await expect(drawer).toContainText("Turns with images");
    await railSettled(page);
    await capture(gallery(page), "gallery-rail-pinned");

    const tall = await overlayBoxes(page);
    expect(overlaps(tall.drawer, tall.prev)).toBe(false);
    expect(overlaps(tall.drawer, tall.next)).toBe(false);
    expect(overlaps(tall.drawer, tall.counter)).toBe(false);
    expect(overlaps(tall.drawer, tall.close)).toBe(false);

    await page.locator(".gallery-rail-entry").nth(3).click();
    await expectUnifiedGallery(page, "6 of 7", "Same shot again for reference.");
    await expect(rail).toHaveClass(/\bopen\b/);

    // Short window: the drawer is anchored top-left and the chevrons ride the
    // vertical centre, so the gap between them is viewport-height dependent.
    await page.setViewportSize({ width: 1400, height: 560 });
    await railSettled(page);
    // The drawer's max-height transitions on resize, so poll it to rest.
    await expect.poll(async () => {
      const b = await overlayBoxes(page);
      return [b.prev, b.next, b.counter, b.close].some((box) => overlaps(b.drawer, box));
    }).toBe(false);
    await capture(gallery(page), "gallery-rail-short-viewport");
  });

  test("Images chip lists every image with filename and turn, and a row opens the gallery", async ({ page }) => {
    await mountChat(page);
    const chip = page.locator("#session-pane .sb-images-btn");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText("7 imgs");
    await chip.click();

    const popover = page.locator(".sb-images-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Images (7)");
    const rows = popover.locator(".sb-images-row");
    await expect(rows).toHaveCount(7);
    await expect(rows.nth(0)).toContainText("crash-report.png");
    await expect(rows.nth(0)).toContainText("Turn 1");
    await expect(rows.nth(0)).toContainText("You");
    await expect(rows.nth(2)).toContainText("capture app window");
    await expect(rows.nth(2)).toContainText("Turn 2");
    await expect(rows.nth(2)).toContainText("Main");
    await expect(rows.nth(5)).toContainText("final capture");
    await expect(rows.nth(5)).toContainText("Turn 4");
    await expect(rows.nth(6)).toContainText("Turn 4");
    await expect(rows.nth(6)).toContainText("You");
    await expect(popover.locator(".sb-images-loading")).toHaveCount(0);
    await capture(popover, "images-chip-popover");

    await rows.nth(4).click();
    await expectUnifiedGallery(page, "5 of 7", "Diff it against the baseline.");
    await expect(popover).toHaveCount(0);
  });
});
