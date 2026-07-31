import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Lightbox composer adopts the shared typing core (composer-unification):
// "/" skill-suggestion popup + purple highlight backdrop, same as the main
// composer/AUQ card/preview-panel - not a reimplementation. Draft-mirror
// contract only (no send path), so this only asserts the typing experience,
// never a submit.

const SLASH_ENTRIES = [
  { name: "close", args: null, description: "Session retrospective", source: { kind: "user-skill" } },
];

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function openLightboxWithComposer(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async ({ b64 }) => {
    const lightbox = await import("/shared/chat/lightbox.ts");
    lightbox.setLightboxComposerBridge({
      getDraftText: () => "",
      setDraftText: () => {},
      getCwd: () => null,
    });
    lightbox.openLightbox({ type: "image", mime: "image/png", base64: b64, filename: "shot.png" });
  }, { b64: TINY_PNG_B64 });
}

test.describe("view-harness / lightbox composer typing core", () => {
  test("typing a known /skill renders the popup and a purple highlight span", async ({ page }) => {
    await mountView(page, { invoke: { list_slash_commands: SLASH_ENTRIES } });
    await openLightboxWithComposer(page);

    const overlay = page.locator(".lightbox-overlay");
    const input = overlay.locator(".lightbox-composer");
    await expect(input).toBeVisible();
    await input.fill("/close");

    const popup = overlay.locator(".caret-popup");
    await expect(popup).toBeVisible();
    await expect(popup.locator(".row .head")).toHaveText("/close");

    const highlight = overlay.locator(".cc-typing-highlight--lightbox");
    const span = highlight.locator(".cm-slash-user-skill");
    await expect(span).toHaveCount(1);
    await expect(span).toHaveText("/close");

    // Real textarea text must be transparent (backdrop technique).
    const textColor = await input.evaluate((el) => getComputedStyle(el).color);
    expect(textColor).toBe("rgba(0, 0, 0, 0)");
  });

  test("Enter inserts a newline instead of submitting or closing the lightbox", async ({ page }) => {
    await mountView(page, { invoke: { list_slash_commands: SLASH_ENTRIES } });
    await openLightboxWithComposer(page);

    const overlay = page.locator(".lightbox-overlay");
    const input = overlay.locator(".lightbox-composer");
    await input.fill("line one");
    await input.press("Enter");
    await input.type("line two");

    await expect(input).toHaveValue("line one\nline two");
    await expect(overlay).toBeVisible();
  });
});
