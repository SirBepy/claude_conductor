import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression (commit 7c355cf9): the phone hardware back button used to skip
// straight past an open lightbox/gallery to the view stack (or exit), instead
// of closing the topmost overlay first. Drives the real registerOverlayBack
// wiring in lightbox.ts / chat-image-gallery.ts through back-button.ts's
// handleBack(), same entry points production's popstate listener calls.

declare global {
  interface Window {
    __backNavCalls?: string[];
  }
}

async function primeViewStack(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const backButton = await import("/shared/back-button.ts");
    window.__backNavCalls = [];
    (window as unknown as { navigateTo: (n: string) => void }).navigateTo = (n: string) => {
      window.__backNavCalls!.push(n);
    };
    backButton.noteNavigation("dashboard");
    backButton.noteNavigation("sessions");
  });
}

test.describe("view-harness / phone back button closes an overlay before the view (todo 471)", () => {
  test("lightbox: first press closes it, view stack untouched", async ({ page }) => {
    await mountView(page);
    await primeViewStack(page);
    await page.evaluate(async () => {
      const lightbox = await import("/shared/chat/lightbox.ts");
      lightbox.openLightbox({ type: "text", content: "hello", filename: "note.txt" });
    });

    await expect(page.locator(".lightbox-overlay")).toBeVisible();
    await page.evaluate(async () => (await import("/shared/back-button.ts")).handleBack());
    await expect(page.locator(".lightbox-overlay")).toHaveCount(0);
    expect(await page.evaluate(() => window.__backNavCalls)).toEqual([]);

    // Second press now falls through to the view stack.
    await page.evaluate(async () => (await import("/shared/back-button.ts")).handleBack());
    expect(await page.evaluate(() => window.__backNavCalls)).toEqual(["dashboard"]);
  });

  test("chat image gallery: first press closes it, view stack untouched", async ({ page }) => {
    await mountView(page);
    await primeViewStack(page);
    await page.evaluate(async () => {
      const gallery = await import("/shared/chat/chat-image-gallery.ts");
      const collection = {
        images: [
          { index: 0, kind: "attachment", mime: "image/png", data: "", title: "a.png", agentKind: "user", agentTag: "user", agentLabel: "You", entryIndex: 0 },
        ],
        entries: [{ turnNumber: 1, name: "Turn 1", images: [0] }],
      };
      gallery.openChatImageGallery(collection as never, 0);
    });

    await expect(page.locator(".chat-image-gallery-overlay")).toBeVisible();
    await page.evaluate(async () => (await import("/shared/back-button.ts")).handleBack());
    await expect(page.locator(".chat-image-gallery-overlay")).toHaveCount(0);
    expect(await page.evaluate(() => window.__backNavCalls)).toEqual([]);
  });
});
