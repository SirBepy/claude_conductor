// Reviewed 2026-11-11: the Undo hold on sends and card answers is gone (a send or answer goes out at once); nothing this spec asserts depends on it, and it passes.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import type { Question } from "../../src/views/sessions/permission-modal/types";

// asserts: src/views/sessions/permission-modal/option-previews.ts, src/views/sessions/permission-modal/preview-fullscreen.ts, src/views/sessions/permission-modal/option-preview-images.ts, src/views/sessions/permission-modal-previews.css
// A question's own picture (Question.preview): shown at the top of the panel
// above the question text, opens fullscreen in "plain" mode (no option paging,
// no Select bar), picks nothing, and a question without one is unchanged.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 393, height: 852 };

// Paints with an app token, so a frame that failed to load the app's
// stylesheets renders it transparent instead of the surface colour.
const PICTURE = `<div class="probe" style="padding:18px;background:var(--color-surface);color:var(--color-text)">Sample header</div>`;

const withPicture: Question = {
  question: "Here is the new header.\n\nIs this good, or do you want to change something?",
  header: "Header",
  domain: "ux",
  preview: PICTURE,
  // Both options look the same, so an option-level preview would not fit.
  options: [{ label: "Good", description: "Ship it" }, { label: "Change something", description: "Say what in the box" }],
};
const withoutPicture: Question = { ...withPicture, preview: undefined };

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

for (const [name, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / AUQ question picture (${name})`, () => {
    test.use({ viewport: size });

    test("the picture sits above the question text, rendered with the app's stylesheets", async ({ page }) => {
      await openCard(page, [withPicture]);
      const pic = page.locator(`${active} .prompt-qpic`);
      await expect(pic).toHaveCount(1);
      const probe = page.frameLocator(`${active} .prompt-qpic__frame`).locator(".probe");
      await expect(probe).toHaveText("Sample header");
      expect(await probe.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

      const picBox = (await pic.boundingBox())!;
      const textBox = (await page.locator(`${active} .prompt-q__text`).boundingBox())!;
      expect(picBox.y + picBox.height).toBeLessThanOrEqual(textBox.y);
      expect(picBox.height).toBeGreaterThan(100);
      // Inside the card, not spilling past it.
      const cardBox = (await page.locator(".prompt-card").boundingBox())!;
      expect(picBox.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(picBox.x + picBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      await page.locator(".prompt-card").screenshot({ path: `.for_bepy/screenshots/_specs/auq-question-picture-${name}.png` });
    });

    test("clicking it opens a plain fullscreen with no option bar, Escape closes it, and nothing is picked", async ({ page }) => {
      await openCard(page, [withPicture]);
      await page.locator(`${active} .prompt-qpic`).click();
      const fs = page.locator(".auq-fs");
      await expect(fs).toBeVisible();
      await expect(fs).toHaveClass(/auq-fs--plain/);
      await expect(page.frameLocator(".auq-fs__frame").locator(".probe")).toHaveText("Sample header");
      await expect(fs.locator(".auq-fs__bar")).toBeHidden();
      await expect(fs.locator('[data-fs="back"]')).toBeHidden();
      await expect(fs.locator(".auq-fs__qtext")).toHaveText("Header");
      await page.screenshot({ path: `.for_bepy/screenshots/_specs/auq-question-picture-fullscreen-${name}.png` });
      // Arrows page options in the option fullscreen; here there is nothing to page.
      await page.keyboard.press("ArrowRight");
      await expect(fs).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(fs).toHaveCount(0);
      expect(await page.evaluate(() => document.querySelectorAll(".prompt-opt > input:checked").length)).toBe(0);
    });

    test("the options still answer the question beside the picture", async ({ page }) => {
      await openCard(page, [withPicture]);
      await page.locator(`${active} .prompt-opt`).filter({ hasText: "Good" }).click();
      await expect.poll(() => page.evaluate(() =>
        document.querySelector<HTMLInputElement>(".prompt-opt > input:checked")?.dataset.label)).toBe("Good");
      await expect(page.locator(".auq-fs")).toHaveCount(0);
    });

    test("a question with no picture renders no picture block and no stage or tiles", async ({ page }) => {
      await openCard(page, [withoutPicture]);
      await expect(page.locator(".prompt-qpic")).toHaveCount(0);
      await expect(page.locator(".prompt-stage")).toHaveCount(0);
      await expect(page.locator(".prompt-opt__pic")).toHaveCount(0);
      await expect(page.locator(`${active} .prompt-q__text`)).toBeVisible();
    });

    test("a local image that cannot be read shows the unavailable tile, not a broken image", async ({ page }) => {
      const missing: Question = {
        ...withPicture,
        preview: `<img id="shot" src="file:///C:/definitely/not/here.png" alt="x" style="max-width:100%">`,
      };
      await openCard(page, [missing]);
      const img = page.frameLocator(`${active} .prompt-qpic__frame`).locator("#shot");
      await expect.poll(async () => (await img.getAttribute("src")) ?? "").toMatch(/^data:image\/svg\+xml,/);
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    });
  });
}

test("an option's own preview still opens the option fullscreen, not the plain one", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const both: Question = {
    ...withPicture,
    options: [{ label: "A", preview: PICTURE }, { label: "B", preview: PICTURE }],
  };
  await openCard(page, [both]);
  await expect(page.locator(`${active} .prompt-qpic`)).toHaveCount(1);
  await page.locator(`${active} .prompt-opt__expand`).first().click();
  const fs = page.locator(".auq-fs");
  await expect(fs).toBeVisible();
  await expect(fs).not.toHaveClass(/auq-fs--plain/);
  await expect(fs.locator(".auq-fs__bar")).toBeVisible();
});
