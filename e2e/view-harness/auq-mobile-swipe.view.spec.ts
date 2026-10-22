// Reviewed 2026-10-22: the phone question card became a fullscreen page (header back arrow + "Question" label and an answer-box send arrow, all hidden on desktop; back collapses the card to its bar instead of falling through) - this spec's contract is unchanged and it passes.
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Phone: swipe left/right over the question track to page between questions,
// same destination as the pager arrows/dots (question-swipe.ts). Ungated like
// the dots/keyboard paging - an unanswered question can be skipped and come
// back to later (see question-keyboard.ts's page()).
//
// Exercises renderQuestionUI directly, same as auq-flow.view.spec.ts - no
// session/composer mount needed, ensureHost() falls back to a viewport-fixed
// card. Synthetic touches: question-swipe.ts listens for touch events, which
// Playwright's mouse never produces (mobile-keyboard.view.spec.ts's pattern).

const PHONE = { width: 393, height: 852 };

declare global {
  interface Window {
    // Must stay identical to auq-flow.view.spec.ts's declaration (TS2717).
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean; extra?: string };
  }
}

async function openCard(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    mod.renderQuestionUI({
      questions: [
        { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
        { question: "Which features?", header: "Features", options: [{ label: "X" }, { label: "Y" }] },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers) => { window.__auqResult!.submitted = answers; },
      onCancel: () => { window.__auqResult!.cancelled = true; },
    });
  });
  await page.locator(".prompt-card").waitFor();
}

const activeTab = (page: Page) =>
  page.evaluate(() => Number(document.querySelector<HTMLElement>(".prompt-panel.is-active")?.dataset.panel));

async function swipeX(page: Page, selector: string, dx: number, dy = 0): Promise<void> {
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

test.describe("view-harness / AUQ mobile swipe paging", () => {
  test.use({ hasTouch: true });

  test("swipe left pages to the next question", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page);
    await openCard(page);
    expect(await activeTab(page)).toBe(0);

    await swipeX(page, ".prompt-track-viewport", -80);
    await expect.poll(() => activeTab(page)).toBe(1);
  });

  test("swipe right pages back to the previous question", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page);
    await openCard(page);

    await swipeX(page, ".prompt-track-viewport", -80);
    await expect.poll(() => activeTab(page)).toBe(1);

    await swipeX(page, ".prompt-track-viewport", 80);
    await expect.poll(() => activeTab(page)).toBe(0);
  });

  test("a short drag under the swipe threshold does not page", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page);
    await openCard(page);

    await swipeX(page, ".prompt-track-viewport", -10);
    expect(await activeTab(page)).toBe(0);
  });

  test("a mostly-vertical drag does not page (belongs to the panel's own scroll)", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page);
    await openCard(page);

    await swipeX(page, ".prompt-track-viewport", -60, -100);
    expect(await activeTab(page)).toBe(0);
  });

  test("swiping past the last question does nothing (clamped like the dots)", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page);
    await openCard(page);

    await swipeX(page, ".prompt-track-viewport", -80);
    await expect.poll(() => activeTab(page)).toBe(1);
    // Review panel (2 questions -> summary at index 2).
    await swipeX(page, ".prompt-track-viewport", -80);
    await expect.poll(() => activeTab(page)).toBe(2);

    await swipeX(page, ".prompt-track-viewport", -80);
    expect(await activeTab(page)).toBe(2);
  });

  test("swipe does nothing at desktop width", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page);
    await openCard(page);

    await swipeX(page, ".prompt-track-viewport", -80);
    expect(await activeTab(page)).toBe(0);
  });
});
