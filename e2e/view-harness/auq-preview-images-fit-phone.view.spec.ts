import { test, expect, type Page, type FrameLocator } from "@playwright/test";
import { mountView } from "./harness";
import type { Question } from "../../src/views/sessions/permission-modal/types";

// asserts: src/views/sessions/permission-modal/option-preview-doc.ts, src/views/sessions/permission-modal/option-previews.ts, src/views/sessions/permission-modal/preview-fullscreen.ts
// An image in a question's or an option's `preview` HTML must show WHOLE in its
// frame at phone width. The frame's body is a centring grid, so an <img> wider
// or taller than the frame once laid out at its natural size and the frame's
// overflow:hidden showed only its top-left part (Joe, 2026-11-20).

const PHONE = { width: 390, height: 844 };

// Real pixel sizes via width/height attributes on an SVG data: URL (img-src
// allows data:), with no max-width of the author's own: the case that broke.
function svgImage(w: number, h: number, id: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<rect width="${w}" height="${h}" fill="#356"/>`
    + `<rect x="${w - 120}" y="${h - 120}" width="120" height="120" fill="#e33"/></svg>`;
  return `<img id="${id}" src="data:image/svg+xml,${encodeURIComponent(svg)}" alt="${id}">`;
}

const WIDE = svgImage(1600, 900, "pic");
const TALL = svgImage(900, 1600, "pic");
// A heading above the image makes the fullscreen page taller than the view, the
// path where fitFrameToView stretches the frame and re-measures.
const withHeading = (img: string) => `<h2 style="margin:0 0 8px">Heading</h2>${img}`;

declare global {
  interface Window {
    // Must stay identical to auq-flow.view.spec.ts's declaration (TS2717).
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean; extra?: string };
  }
}

async function openCard(page: Page, q: Question): Promise<void> {
  await page.setViewportSize(PHONE);
  await mountView(page);
  await page.evaluate(async (qs) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    mod.renderQuestionUI({
      questions: qs,
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  }, [q]);
  await page.locator(".prompt-card").waitFor();
}

// The image's box against its own frame's viewport: every edge inside, and the
// natural aspect ratio kept (a squashed image would also "fit").
async function expectWhole(frame: FrameLocator, natural: { w: number; h: number }): Promise<void> {
  const img = frame.locator("#pic");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  const m = await img.evaluate((el: HTMLImageElement) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  expect(m.l).toBeGreaterThanOrEqual(-0.5);
  expect(m.t).toBeGreaterThanOrEqual(-0.5);
  expect(m.r).toBeLessThanOrEqual(m.vw + 0.5);
  expect(m.b).toBeLessThanOrEqual(m.vh + 0.5);
  expect(Math.abs(m.w / m.h - natural.w / natural.h)).toBeLessThan(0.02);
}

// The fullscreen frame is stretched and scaled by fitFrameToView, so "whole"
// is judged where the image lands on the page, inside the zoom view.
async function expectWholeInFullscreen(page: Page): Promise<void> {
  const frame = page.locator(".auq-fs__frame");
  await expect(frame).toBeVisible();
  await expect.poll(() => frame.evaluate((f: HTMLIFrameElement) => {
    const img = f.contentDocument?.querySelector("#pic") as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  })).toBe(true);
  // Let the load listeners refit the frame.
  await page.waitForTimeout(400);
  const m = await frame.evaluate((f: HTMLIFrameElement) => {
    const img = f.contentDocument!.querySelector("#pic") as HTMLImageElement;
    const fr = f.getBoundingClientRect();
    const scale = fr.width / f.offsetWidth;
    const r = img.getBoundingClientRect();
    const view = document.querySelector(".auq-fs__view")!.getBoundingClientRect();
    return { l: fr.left + r.left * scale, t: fr.top + r.top * scale, r: fr.left + r.right * scale,
      b: fr.top + r.bottom * scale, view: { l: view.left, t: view.top, r: view.right, b: view.bottom } };
  });
  expect(m.l).toBeGreaterThanOrEqual(m.view.l - 1);
  expect(m.t).toBeGreaterThanOrEqual(m.view.t - 1);
  expect(m.r).toBeLessThanOrEqual(m.view.r + 1);
  expect(m.b).toBeLessThanOrEqual(m.view.b + 1);
}

const active = ".prompt-panel.is-active";
const SHAPES = [
  { name: "wide 1600x900", html: WIDE, natural: { w: 1600, h: 900 } },
  { name: "tall 900x1600", html: TALL, natural: { w: 900, h: 1600 } },
];

for (const shape of SHAPES) {
  test.describe(`view-harness / AUQ preview images at phone width (${shape.name})`, () => {
    test("an option image shows whole in the stage and in the fullscreen view", async ({ page }) => {
      await openCard(page, {
        question: "Which crop?",
        header: "Crop",
        domain: "ux",
        options: [
          { label: "A", description: "first", preview: shape.html },
          { label: "B", description: "second", preview: shape.html },
        ],
      });
      await expectWhole(page.frameLocator(`${active} .prompt-stage__frame`), shape.natural);

      await page.locator(`${active} .prompt-stage__hit`).click();
      await expect(page.locator(".auq-fs")).toBeVisible();
      await expectWholeInFullscreen(page);
    });

    test("with a heading above it, the fullscreen page still shows the whole image", async ({ page }) => {
      await openCard(page, {
        question: "Which crop?",
        header: "Crop",
        domain: "ux",
        options: [
          { label: "A", preview: withHeading(shape.html) },
          { label: "B", preview: withHeading(shape.html) },
        ],
      });
      await page.locator(`${active} .prompt-stage__hit`).click();
      await expect(page.locator(".auq-fs")).toBeVisible();
      await expectWholeInFullscreen(page);
    });

    test("a question picture shows whole in its frame and in the fullscreen view", async ({ page }) => {
      await openCard(page, {
        question: "Is this crop right?",
        header: "Crop",
        domain: "ux",
        preview: shape.html,
        options: [{ label: "Good" }, { label: "Change it" }],
      });
      await expectWhole(page.frameLocator(`${active} .prompt-qpic__frame`), shape.natural);

      await page.locator(`${active} .prompt-qpic`).click();
      await expect(page.locator(".auq-fs")).toBeVisible();
      await expectWholeInFullscreen(page);
    });
  });
}

test.describe("view-harness / AUQ preview frame keeps what already worked (phone)", () => {
  test("a small image keeps its size and sits centred in the stage frame", async ({ page }) => {
    await openCard(page, {
      question: "Which?",
      header: "Icon",
      domain: "ux",
      options: [
        { label: "A", preview: svgImage(100, 60, "pic") },
        { label: "B", preview: svgImage(100, 60, "pic") },
      ],
    });
    const img = page.frameLocator(`${active} .prompt-stage__frame`).locator("#pic");
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    const m = await img.evaluate((el: HTMLImageElement) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, cx: (r.left + r.right) / 2, vw: innerWidth };
    });
    expect(Math.round(m.w)).toBe(100);
    expect(Math.round(m.h)).toBe(60);
    expect(Math.abs(m.cx - m.vw / 2)).toBeLessThan(1);
  });

  test("an author's width and height attributes still show the whole image, undistorted", async ({ page }) => {
    const sized = svgImage(1600, 900, "pic").replace("<img ", '<img width="1600" height="900" ');
    await openCard(page, {
      question: "Which?",
      header: "Crop",
      domain: "ux",
      options: [{ label: "A", preview: sized }, { label: "B", preview: sized }],
    });
    const frame = page.frameLocator(`${active} .prompt-stage__frame`);
    const img = frame.locator("#pic");
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    const m = await img.evaluate((el: HTMLImageElement) => {
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight, fit: getComputedStyle(el).objectFit };
    });
    expect(m.l).toBeGreaterThanOrEqual(-0.5);
    expect(m.r).toBeLessThanOrEqual(m.vw + 0.5);
    expect(m.b).toBeLessThanOrEqual(m.vh + 0.5);
    // The box may be squeezed by the two attributes; contain keeps the picture's own ratio inside it.
    expect(m.fit).toBe("contain");
  });
});
