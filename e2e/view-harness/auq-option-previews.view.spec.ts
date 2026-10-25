// Reviewed 2026-10-22: the phone question card became a fullscreen page (header back arrow + "Question" label and an answer-box send arrow, all hidden on desktop; back collapses the card to its bar instead of falling through) - this spec's contract is unchanged and it passes.
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import type { Question } from "../../src/views/sessions/permission-modal/types";

// Visual option previews (option-previews.ts): tiles for 1-3 previewed
// options on desktop, one stage for 4+ or any phone, phone browsing via
// filmstrip + vertical swipe + "Choose this". Drives the real renderQuestionUI
// with no composer mounted, so ensureHost() falls back to a viewport card.

const DESKTOP = { width: 1280, height: 1000 };
const PHONE = { width: 393, height: 852 };

// The probe paints with an app token, so a frame that failed to load the
// app's stylesheets renders it transparent instead of the surface colour.
const frag = (label: string) =>
  `<div class="probe" style="padding:10px;background:var(--color-surface);color:var(--color-text)">${label}</div>`;

const opt = (label: string) => ({ label, description: `${label} desc`, preview: frag(label) });

const question = (n: number): Question => ({
  question: "Where should the unread marker sit?",
  header: "Marker",
  domain: "ux",
  options: ["One", "Two", "Three", "Four", "Five"].slice(0, n).map(opt),
});

declare global {
  interface Window {
    // Must stay identical to auq-flow.view.spec.ts's declaration (TS2717).
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean; extra?: string };
  }
}

async function openCard(page: Page, questions: Question[]): Promise<void> {
  await mountView(page);
  await page.evaluate(async (qs) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    mod.renderQuestionUI({
      questions: qs,
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers) => { window.__auqResult!.submitted = answers; },
      onCancel: () => { window.__auqResult!.cancelled = true; },
    });
  }, questions);
  await page.locator(".prompt-card").waitFor();
}

const active = ".prompt-panel.is-active";
const stageLabel = (page: Page) => page.locator(`${active} .prompt-stage__label`).textContent();
const picked = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLInputElement>(".prompt-panel.is-active .prompt-opt > input:checked")?.dataset.label ?? null);

async function swipe(page: Page, selector: string, dx: number, dy: number): Promise<void> {
  await page.evaluate(({ selector, dx, dy }) => {
    const el = document.querySelector<HTMLElement>(selector)!;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const at = (cx: number, cy: number) => new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy });
    el.dispatchEvent(new TouchEvent("touchstart", { touches: [at(x, y)], bubbles: true, cancelable: true }));
    el.dispatchEvent(new TouchEvent("touchmove", { touches: [at(x + dx, y + dy)], bubbles: true, cancelable: true }));
    el.dispatchEvent(new TouchEvent("touchend", { changedTouches: [at(x + dx, y + dy)], touches: [], bubbles: true, cancelable: true }));
  }, { selector, dx, dy });
}

test.describe("view-harness / AUQ option previews", () => {
  test("desktop, 3 previewed options: tiles side by side, picture click opens fullscreen, row click picks", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [question(3)]);

    const panel = page.locator(active);
    await expect(panel).toHaveClass(/prompt-panel--preview-tiles/);
    await expect(panel.locator(".prompt-stage")).toHaveCount(0);
    const pics = panel.locator(".prompt-opt__pic");
    await expect(pics).toHaveCount(3);

    // One row, three equal columns.
    const boxes = await Promise.all([0, 1, 2].map((i) => pics.nth(i).boundingBox()));
    expect(Math.abs(boxes[0]!.y - boxes[2]!.y)).toBeLessThan(2);
    expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(2);
    expect(boxes[0]!.width).toBeGreaterThan(150);

    // The fragment rendered with the app's stylesheets: the token resolved.
    const probe = page.frameLocator(`${active} .prompt-opt__frame`).nth(1).locator(".probe");
    await expect(probe).toHaveText("Two");
    const bg = await probe.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");

    // The picture opens fullscreen (preview-fullscreen.ts) without picking.
    await pics.nth(1).click();
    await expect(page.locator(".auq-fs")).toBeVisible();
    expect(await picked(page)).toBeNull();
    await page.locator('.auq-fs [data-fs="close"]').click();
    await expect(page.locator(".auq-fs")).toHaveCount(0);

    await panel.locator(".prompt-opt__body").nth(1).click();
    await expect.poll(() => picked(page)).toBe("Two");
    await page.locator(".prompt-card").screenshot({ path: ".for_bepy/screenshots/_specs/auq-option-previews-tiles.png" });
  });

  test("desktop, 5 previewed options: one stage that follows hover, then the pick", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [question(5)]);

    const panel = page.locator(active);
    await expect(panel).toHaveClass(/prompt-panel--preview-stage/);
    await expect(panel.locator(".prompt-opt__pic")).toHaveCount(0);
    await expect(panel.locator(".prompt-stage__thumb")).toHaveCount(0);
    await expect.poll(() => stageLabel(page)).toBe("One");
    await expect(panel.locator(".prompt-stage__count")).toHaveText("1/5");

    await panel.locator(".prompt-opt").nth(3).hover();
    await expect.poll(() => stageLabel(page)).toBe("Four");
    await expect(page.frameLocator(`${active} .prompt-stage__frame`).locator(".probe")).toHaveText("Four");
    // Desktop picks by clicking rows; "Choose this" is a phone affordance.
    await expect(panel.locator(".prompt-stage__choose")).toBeHidden();

    await panel.locator(".prompt-opt").nth(1).click();
    await expect.poll(() => picked(page)).toBe("Two");
    await page.locator('[data-act="cancel"]').hover();
    await expect.poll(() => stageLabel(page)).toBe("Two");
    await page.locator(".prompt-card").screenshot({ path: ".for_bepy/screenshots/_specs/auq-option-previews-stage.png" });
  });

  test.describe("phone", () => {
    test.use({ hasTouch: true });

    test("3 options still use the stage, with a filmstrip and Choose this", async ({ page }) => {
      await page.setViewportSize(PHONE);
      await openCard(page, [question(3)]);

      const panel = page.locator(active);
      await expect(panel).toHaveClass(/prompt-panel--preview-stage/);
      await expect(panel.locator(".prompt-stage__thumb")).toHaveCount(3);

      await panel.locator(".prompt-stage__thumb").nth(2).click();
      await expect.poll(() => stageLabel(page)).toBe("Three");
      await expect(panel.locator(".prompt-stage__thumb.is-current")).toHaveAttribute("data-stage-i", "2");
      // Viewing is not picking.
      expect(await picked(page)).toBeNull();
      await expect(panel.locator(".prompt-opt.is-previewing input")).toHaveAttribute("data-label", "Three");

      await panel.locator(".prompt-stage__choose").click();
      await expect.poll(() => picked(page)).toBe("Three");
      await expect(page.locator(`${active} .prompt-stage__choose`)).toBeHidden();
      await expect(page.locator(`${active} .prompt-opt.is-previewing`)).toHaveCount(0);
    });

    test("vertical swipe on the picture steps options; sideways still pages questions", async ({ page }) => {
      await page.setViewportSize(PHONE);
      await openCard(page, [question(5), { question: "Second?", header: "Next", options: [{ label: "X" }, { label: "Y" }] }]);

      await expect.poll(() => stageLabel(page)).toBe("One");
      await swipe(page, `${active} .prompt-stage__hit`, 0, -90);
      await expect.poll(() => stageLabel(page)).toBe("Two");
      await swipe(page, `${active} .prompt-stage__hit`, 0, -90);
      await expect.poll(() => stageLabel(page)).toBe("Three");
      await swipe(page, `${active} .prompt-stage__hit`, 0, 90);
      await expect.poll(() => stageLabel(page)).toBe("Two");
      expect(await picked(page)).toBeNull();
      await page.locator(".prompt-card").screenshot({ path: ".for_bepy/screenshots/_specs/auq-option-previews-phone.png" });

      await swipe(page, `${active} .prompt-stage__hit`, -90, 0);
      await expect.poll(() => page.evaluate(() => Number(document.querySelector<HTMLElement>(".prompt-panel.is-active")?.dataset.panel))).toBe(1);
    });
  });

  test("options without previews render exactly as before", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [{ question: "Which?", domain: "arch", options: [{ label: "A" }, { label: "B" }] }]);
    const panel = page.locator(active);
    await expect(panel).not.toHaveClass(/prompt-panel--preview/);
    await expect(panel.locator("iframe")).toHaveCount(0);
  });
});
