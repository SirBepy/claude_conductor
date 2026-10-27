import { test, expect } from "@playwright/test";
import { mountSessionsLayout, mountView } from "./harness";
import { buildPreviewDocumentHtml } from "../../src/views/sessions/preview-panel-document";

// asserts: src/views/sessions/preview-panel-zoom-gate.ts

// The Preview panel's page takes every click until zoom/pan is armed (Ctrl or
// Cmd held, or the Zoom toggle pressed); only then does the iframe let the
// pointer through to the stage's shared image-zoom-pan.ts listeners. By
// default `render_preview_doc` returns about:blank: the stage is built before
// that IPC resolves, and those specs only drive the stage.

async function openPreview(
  page: import("@playwright/test").Page,
  renderedDoc = "about:blank",
  opts: { failRender?: boolean; trackStages?: boolean } = {},
): Promise<void> {
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
      render_preview_doc: renderedDoc,
    },
  });
  await mountSessionsLayout(page);
  if (opts.failRender || opts.trackStages) {
    await page.evaluate((fail) => {
      const w = window as unknown as { __stages: HTMLElement[]; __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } };
      const passthrough = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => (fail && cmd === "render_preview_doc" ? Promise.reject(new Error("no stage")) : passthrough(cmd, args));
      w.__stages = [];
      new MutationObserver((records) => {
        for (const r of records) r.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement) n.querySelectorAll<HTMLElement>(".pv-stage").forEach((s) => w.__stages.push(s));
        });
      }).observe(document.body, { childList: true, subtree: true });
    }, !!opts.failRender);
  }
  await page.evaluate(() => (window as unknown as { __preview: { open(id: string): void } }).__preview.open("snap-1"));
}

const zoomTransform = (page: import("@playwright/test").Page) =>
  page.locator('.sp-panel[data-active="preview"] .pv-zoomee').evaluate((el) => (el as HTMLElement).style.transform);

test("the page takes the pointer by default and a plain click does not zoom", async ({ page }) => {
  await openPreview(page);
  const root = page.locator('.sp-panel[data-active="preview"]');
  const iframe = root.locator("iframe.pv-iframe");
  await expect(iframe).toBeVisible();

  expect(await iframe.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
  await iframe.click();
  expect(await zoomTransform(page)).not.toMatch(/scale\((?!1\))[\d.]+\)/);
});

test("holding Ctrl arms wheel zoom, and releasing it hands the page back", async ({ page }) => {
  await openPreview(page);
  const root = page.locator('.sp-panel[data-active="preview"]');
  const iframe = root.locator("iframe.pv-iframe");
  const pointerEvents = () => iframe.evaluate((el) => getComputedStyle(el).pointerEvents);
  await expect(iframe).toBeVisible();

  await root.locator(".pv-stage").hover();
  await page.keyboard.down("Control");
  expect(await pointerEvents()).toBe("none");
  await page.mouse.wheel(0, -400);
  await expect.poll(() => zoomTransform(page)).toMatch(/scale\((?!1\))[\d.]+\)/);

  await page.keyboard.up("Control");
  expect(await pointerEvents()).toBe("auto");
});

test("Ctrl pressed while focus is inside the page still arms zoom", async ({ page }) => {
  const doc = buildPreviewDocumentHtml(`<!doctype html><html><head></head><body><button id="b">page</button></body></html>`, { forwardZoomKeys: true });
  await openPreview(page, `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`);
  const root = page.locator('.sp-panel[data-active="preview"]');
  const stage = root.locator(".pv-stage");
  const frame = root.frameLocator("iframe.pv-iframe");

  await frame.locator("#b").click();
  await page.keyboard.down("Control");
  await expect(stage).toHaveClass(/is-zoom/);
  await page.keyboard.up("Control");
  await expect(stage).not.toHaveClass(/is-zoom/);
});

test("a Ctrl+click on the stage after the page had focus keeps zoom armed", async ({ page }) => {
  const doc = buildPreviewDocumentHtml(`<!doctype html><html><head></head><body><button id="b">page</button></body></html>`, { forwardZoomKeys: true });
  await openPreview(page, `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`);
  const root = page.locator('.sp-panel[data-active="preview"]');
  const stage = root.locator(".pv-stage");

  await root.frameLocator("iframe.pv-iframe").locator("#b").click();
  await page.keyboard.down("Control");
  await expect(stage).toHaveClass(/is-zoom/);
  // The click moves focus from the page out to the panel, blurring the page.
  await stage.click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(100);
  await expect(stage).toHaveClass(/is-zoom/);
  await page.keyboard.up("Control");
  await expect(stage).not.toHaveClass(/is-zoom/);
});

test("the Zoom toggle arms zoom/pan for touch and disarms it again", async ({ page }) => {
  await openPreview(page);
  const root = page.locator('.sp-panel[data-active="preview"]');
  const iframe = root.locator("iframe.pv-iframe");
  const toggle = root.locator(".pv-zoom-toggle");
  const pointerEvents = () => iframe.evaluate((el) => getComputedStyle(el).pointerEvents);

  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await pointerEvents()).toBe("auto");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await pointerEvents()).toBe("none");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await pointerEvents()).toBe("auto");
});

test("a failed render drops the zoom listeners instead of leaving them on the detached stage", async ({ page }) => {
  await openPreview(page, "about:blank", { failRender: true });
  await expect(page.locator('.sp-panel[data-active="preview"] .pv-empty')).toContainText("Preview failed to render");

  await page.keyboard.down("Control");
  // A live gate would still add .is-zoom to the stage that was just replaced.
  const armed = await page.evaluate(() => (window as unknown as { __stages: HTMLElement[] }).__stages.some((s) => s.classList.contains("is-zoom")));
  await page.keyboard.up("Control");
  expect(armed).toBe(false);
});

test("a chat with no previews drops the zoom listeners when the canvas goes empty", async ({ page }) => {
  await openPreview(page, "about:blank", { trackStages: true });
  await expect(page.locator('.sp-panel[data-active="preview"] .pv-stage')).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } };
    const passthrough = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => (cmd === "list_previews" ? Promise.resolve([]) : passthrough(cmd, args));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator('.sp-panel[data-active="preview"] .pv-empty')).toContainText("No previews yet");

  await page.keyboard.down("Control");
  const armed = await page.evaluate(() => (window as unknown as { __stages: HTMLElement[] }).__stages.some((s) => s.classList.contains("is-zoom")));
  await page.keyboard.up("Control");
  expect(armed).toBe(false);
});
