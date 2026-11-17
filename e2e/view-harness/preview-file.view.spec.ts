import { test, expect } from "@playwright/test";
import { buildFilePreviewHtml } from "../../src/views/sessions/preview-panel-document";

// asserts: src/views/sessions/preview-panel-document.ts, src/shared/preview-file.ts

// A file opened in the Preview panel is a plain page. Its Rendered / Source
// switch is two radios and sibling selectors, so the switch must work in a real
// browser with no script at all (the unit test only sees the markup).

const markdown = buildFilePreviewHtml({
  kind: "markdown", path: "C:/proj/README.md", renderedHtml: "<h1>Title</h1><p>Body</p>", source: "# Title\n\nBody\n", truncated: false,
});

test("markdown opens rendered, the Source tab swaps to the raw text and back", async ({ page }) => {
  await page.setContent(markdown);
  await expect(page.locator(".pf-rendered h1")).toBeVisible();
  await expect(page.locator(".pf-source")).toBeHidden();

  await page.locator('label[for="pf-v-s"]').click();
  await expect(page.locator(".pf-rendered")).toBeHidden();
  await expect(page.locator(".pf-source")).toBeVisible();
  await expect(page.locator(".pf-source")).toHaveText(/# Title/);

  await page.locator('label[for="pf-v-r"]').click();
  await expect(page.locator(".pf-rendered h1")).toBeVisible();
  await expect(page.locator(".pf-source")).toBeHidden();
});

test("an error page shows its message and no switch", async ({ page }) => {
  await page.setContent(buildFilePreviewHtml({ kind: "error", path: "C:/proj/gone.md", message: "gone.md was not found." }));
  await expect(page.getByRole("alert")).toHaveText("gone.md was not found.");
  await expect(page.locator(".pf-tab")).toHaveCount(0);
});

test("an image page draws the image", async ({ page }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  await page.setContent(buildFilePreviewHtml({ kind: "image", path: "C:/proj/dot.png", src: `data:image/png;base64,${png}` }));
  const img = page.locator("img.pf-img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
});
