import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { mountSessionsLayout, mountView } from "./harness";
import { buildPreviewDocumentHtml } from "../../src/views/sessions/preview-panel-document";

// asserts: src/views/sessions/preview-panel-document.ts, src/views/sessions/preview-templates.ts, src/views/sessions/preview-page-zoom.ts

// Every pushed preview is a real page: the panel puts a template around it
// (centered column, padding that shrinks on a phone) and the page zooms
// itself (pinch, double-tap, Ctrl+wheel). There is no zoom button or stage
// gate, so the iframe always takes the pointer and scroll natively.

// A pane in the desktop split, or the full-screen cover on a phone.
const PANEL = ':is(.sp-panel, .pw-window)[data-active="preview"]';

function pageDoc(body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

async function openPreview(page: Page, html: string, opts: { failRender?: boolean; phone?: boolean } = {}): Promise<void> {
  const doc = buildPreviewDocumentHtml(html, { zoom: true });
  await mountView(page, {
    invoke: {
      list_previews: [
        {
          id: "snap-1", slug: "fixture", title: "Fixture", source: "chat",
          session_id: "sess-1", version: 1, created_at: new Date().toISOString(),
        },
      ],
      get_preview: {
        id: "snap-1", slug: "fixture", title: "Fixture", html,
        source: "chat", session_id: "sess-1", version: 1, created_at: new Date().toISOString(),
      },
      render_preview_doc: `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`,
    },
  });
  await mountSessionsLayout(page, opts.phone ? { header: true, fab: true } : undefined);
  if (opts.failRender) {
    await page.evaluate(() => {
      const w = window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } };
      const passthrough = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => (cmd === "render_preview_doc" ? Promise.reject(new Error("no stage")) : passthrough(cmd, args));
    });
  }
  if (opts.phone) {
    // The phone's only way in is the FAB dial.
    await page.locator(".fab-dial-fab").click();
    await page.locator('[data-dial="preview"]').click();
    return;
  }
  await page.evaluate(() => (window as unknown as { __preview: { open(id: string): void } }).__preview.open("snap-1"));
}

const bodyStyle = (page: Page) =>
  page.frameLocator(`${PANEL} iframe.pv-iframe`).locator("body").evaluate((el) => {
    const s = getComputedStyle(el);
    return { paddingLeft: parseFloat(s.paddingLeft), paddingTop: parseFloat(s.paddingTop), maxWidth: s.maxWidth, left: el.getBoundingClientRect().left };
  });

const rootZoom = (page: Page) =>
  page.frameLocator(`${PANEL} iframe.pv-iframe`).locator("html").evaluate((el) => Number((el as HTMLElement).style.zoom || "1"));

test.describe("view-harness / preview page template and zoom (desktop)", () => {
  test("the zoom button and stage are gone, and the page takes the pointer", async ({ page }) => {
    await openPreview(page, pageDoc("<p>hi</p>"));
    const iframe = page.locator(`${PANEL} iframe.pv-iframe`);
    await expect(iframe).toBeVisible();
    await expect(page.locator(`${PANEL} .pv-zoom-toggle`)).toHaveCount(0);
    expect(await iframe.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
  });

  test("a page that zeroes its margin still gets padding and a centered column", async ({ page }) => {
    await openPreview(page, pageDoc("<p>edge to edge before the template</p>", "<style>body{margin:0}</style>"));
    await page.locator(`${PANEL} iframe.pv-iframe`).waitFor();
    await expect.poll(async () => (await bodyStyle(page)).paddingLeft).toBeGreaterThanOrEqual(12);
    const s = await bodyStyle(page);
    expect(s.paddingTop).toBeGreaterThanOrEqual(12);
    expect(s.maxWidth).toBe("1040px");
  });

  test("a page's own body rule beats the template", async ({ page }) => {
    await openPreview(page, pageDoc("<p>own layout</p>", "<style>body{padding:0;max-width:none}</style>"));
    await page.locator(`${PANEL} iframe.pv-iframe`).waitFor();
    await expect.poll(async () => (await bodyStyle(page)).maxWidth).toBe("none");
    expect((await bodyStyle(page)).paddingLeft).toBe(0);
  });

  test("a bare page keeps none of the template", async ({ page }) => {
    await openPreview(page, pageDoc("<p>owns its layout</p>", '<meta name="preview-template" content="bare">'));
    await page.locator(`${PANEL} iframe.pv-iframe`).waitFor();
    await expect.poll(async () => (await bodyStyle(page)).maxWidth).toBe("none");
    expect((await bodyStyle(page)).paddingLeft).toBe(0);
  });

  test("Ctrl+wheel inside the page zooms it and Ctrl+0 resets", async ({ page }) => {
    await openPreview(page, pageDoc('<p style="height:2000px">tall</p><button id="b">b</button>'));
    const frame = page.frameLocator(`${PANEL} iframe.pv-iframe`);
    await frame.locator("body").waitFor();
    const box = (await page.locator(`${PANEL} iframe.pv-iframe`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await expect.poll(() => rootZoom(page)).toBeGreaterThan(1);
    await page.keyboard.up("Control");

    await frame.locator("body").click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+0");
    await expect.poll(() => rootZoom(page)).toBe(1);
    await page.keyboard.press("Control+=");
    await expect.poll(() => rootZoom(page)).toBeGreaterThan(1);
  });

  test("a plain scroll over the page does not zoom it", async ({ page }) => {
    await openPreview(page, pageDoc('<p style="height:2000px">tall</p>'));
    await page.frameLocator(`${PANEL} iframe.pv-iframe`).locator("body").waitFor();
    const box = (await page.locator(`${PANEL} iframe.pv-iframe`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(150);
    expect(await rootZoom(page)).toBe(1);
  });

  test("a failed render shows the failure card", async ({ page }) => {
    await openPreview(page, pageDoc("<p>x</p>"), { failRender: true });
    await expect(page.locator(`${PANEL} .pv-empty`)).toContainText("Preview failed to render");
  });
});

type Pt = { x: number; y: number };
async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", pts: Pt[]): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
}

test.describe("view-harness / preview page zoom on a phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

  async function frameCentre(page: Page): Promise<Pt> {
    const box = (await page.locator(`${PANEL} iframe.pv-iframe`).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  test("the template pads a phone-width page by 12px", async ({ page }) => {
    await openPreview(page, pageDoc("<p>phone</p>", "<style>body{margin:0}</style>"), { phone: true });
    await page.locator(`${PANEL} iframe.pv-iframe`).waitFor();
    await expect.poll(async () => (await bodyStyle(page)).paddingLeft).toBeGreaterThan(0);
    expect((await bodyStyle(page)).paddingLeft).toBe(12);
  });

  test("two fingers spreading apart zoom the page, pinching back out returns it", async ({ page }) => {
    await openPreview(page, pageDoc('<p style="height:2000px">tall</p>'), { phone: true });
    await page.frameLocator(`${PANEL} iframe.pv-iframe`).locator("body").waitFor();
    const cdp = await page.context().newCDPSession(page);
    const c = await frameCentre(page);
    const spread = async (from: number, to: number) => {
      await touch(cdp, "touchStart", [{ x: c.x - from, y: c.y }]);
      await touch(cdp, "touchStart", [{ x: c.x - from, y: c.y }, { x: c.x + from, y: c.y }]);
      for (let i = 1; i <= 6; i++) {
        const d = from + ((to - from) * i) / 6;
        await touch(cdp, "touchMove", [{ x: c.x - d, y: c.y }, { x: c.x + d, y: c.y }]);
      }
      await touch(cdp, "touchEnd", []);
    };
    await spread(20, 80);
    await expect.poll(() => rootZoom(page)).toBeGreaterThan(2);
    await spread(80, 10);
    await expect.poll(() => rootZoom(page)).toBeLessThan(1.5);
  });

  test("a double tap zooms in and a second double tap zooms back out", async ({ page }) => {
    await openPreview(page, pageDoc('<p style="height:2000px">tall</p>'), { phone: true });
    await page.frameLocator(`${PANEL} iframe.pv-iframe`).locator("body").waitFor();
    const cdp = await page.context().newCDPSession(page);
    const c = await frameCentre(page);
    const tap = async () => {
      await touch(cdp, "touchStart", [c]);
      await touch(cdp, "touchEnd", []);
    };
    await tap();
    await tap();
    await expect.poll(() => rootZoom(page)).toBeGreaterThan(2);
    await page.waitForTimeout(400);
    await tap();
    await tap();
    await expect.poll(() => rootZoom(page)).toBe(1);
  });
});
