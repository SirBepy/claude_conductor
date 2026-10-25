import { test, expect } from "@playwright/test";
import { mountSessionsLayout, mountView } from "./harness";

// The Preview panel's page zooms on the wheel and pans on a drag (the shared
// image-zoom-pan.ts), so the iframe swallows no pointer events until the
// Interact toggle hands them back to the page. `render_preview_doc` returns
// about:blank: the stage is built before that IPC resolves, and the spec only
// drives the stage, never the staged document.

async function openPreview(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, {
    invoke: {
      list_previews: [
        {
          id: "snap-1", slug: "fixture", title: "Fixture", source: "chat",
          session_id: "sess-1", version: 1, created_at: new Date().toISOString(),
        },
      ],
      get_preview: {
        id: "snap-1", slug: "fixture", title: "Fixture", html: "<p>hi</p>",
        source: "chat", session_id: "sess-1", version: 1, created_at: new Date().toISOString(),
      },
      render_preview_doc: "about:blank",
    },
  });
  await mountSessionsLayout(page);
  await page.evaluate(() => (window as unknown as { __preview: { open(id: string): void } }).__preview.open("snap-1"));
}

test("a wheel over the preview stage zooms the page in", async ({ page }) => {
  await openPreview(page);
  const root = page.locator('.sp-panel[data-active="preview"]');
  const stage = root.locator(".pv-stage");
  await expect(stage).toBeVisible();

  await stage.hover();
  await page.mouse.wheel(0, -400);

  await expect
    .poll(() => root.locator(".pv-zoomee").evaluate((el) => (el as HTMLElement).style.transform))
    .toMatch(/scale\((?!1\))[\d.]+\)/);
});

test("the Interact toggle hands pointer events back to the iframe and back again", async ({ page }) => {
  await openPreview(page);
  const root = page.locator('.sp-panel[data-active="preview"]');
  const iframe = root.locator("iframe.pv-iframe");
  const toggle = root.locator(".pv-interact");
  const pointerEvents = () => iframe.evaluate((el) => getComputedStyle(el).pointerEvents);

  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await pointerEvents()).toBe("none");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await pointerEvents()).toBe("auto");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await pointerEvents()).toBe("none");
});
