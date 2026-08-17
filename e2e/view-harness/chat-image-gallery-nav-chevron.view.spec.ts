import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression: the gallery's stage <img> used to sit above the prev/next nav
// buttons in stacking order, so a full-bleed image ate the click meant for
// the left chevron. chat-image-gallery.css now pins the nav to z-index:1
// above the stage.

// 1x1 PNG, tiny but enough to force the <img> to actually paint and cover
// the stage the nav buttons are absolutely positioned over.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function openGallery(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async (data) => {
    const gallery = await import("/shared/chat/chat-image-gallery.ts");
    const collection = {
      images: [
        { index: 0, kind: "attachment", mime: "image/png", data, title: "first.png", agentKind: "user", agentTag: "user", agentLabel: "You", entryIndex: 0 },
        { index: 1, kind: "attachment", mime: "image/png", data, title: "second.png", agentKind: "user", agentTag: "user", agentLabel: "You", entryIndex: 1 },
      ],
      entries: [
        { turnNumber: 1, name: "Turn 1", images: [0] },
        { turnNumber: 2, name: "Turn 2", images: [1] },
      ],
    };
    gallery.openChatImageGallery(collection as never, 1);
  }, PNG_1PX);
}

test.describe("view-harness / chat image gallery nav chevron over full-bleed image (todo 471)", () => {
  test("the prev chevron is hit-testable, not covered by the stage image", async ({ page }) => {
    await mountView(page);
    await openGallery(page);

    const prevBtn = page.locator(".screenshot-gallery-nav--prev");
    await expect(prevBtn).toBeVisible();
    const img = page.locator(".screenshot-gallery-stage img");
    await expect(img).toBeVisible();

    const hit = await prevBtn.evaluate((btn) => {
      const r = btn.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el === btn || btn.contains(el);
    });
    expect(hit).toBe(true);

    await prevBtn.click();
    const counter = page.locator(".gallery-total-counter");
    await expect(counter).toHaveText("1 of 2");
  });
});
