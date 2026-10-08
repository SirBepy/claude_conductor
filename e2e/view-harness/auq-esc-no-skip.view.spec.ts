// Reviewed 2026-10-08: question-ui.ts's confirmQuestionRendered now also threads the prompt's sessionId to confirm_question_rendered (multi-machine prompt routing, docs/multi-machine.md) - additive, no UI-behavior change for this spec's contract.
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Escape must never skip an AUQ card. A skipped card settles as SKIPPED, with
// no answer at all reaching the agent, and Escape is reflexive enough to burn
// a whole prompt by accident. Its only remaining job is dropping focus out of
// a text field; the footer's "Skip" button is the one explicit route.
//
// Absorbs todo 442's lightbox regression: an Escape meant for an image
// lightbox atop the card used to cancel the card on the same keypress. Drives
// the real renderQuestionUI + openLightbox entry points so this survives a
// render() rewrite.

declare global {
  interface Window {
    // Must stay identical to auq-flow.view.spec.ts's declaration: TS merges
    // global interfaces, and a property declared twice with differing types is
    // an error in whichever file declares it second.
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean; extra?: string };
  }
}

async function openCard(page: import("@playwright/test").Page, withLightbox: boolean): Promise<void> {
  await page.evaluate(async (openImage) => {
    const questionUi = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    questionUi.renderQuestionUI({
      questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] }],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers) => { window.__auqResult!.submitted = answers; },
      onCancel: () => { window.__auqResult!.cancelled = true; },
    });
    if (openImage) {
      const lightbox = await import("/shared/chat/lightbox.ts");
      lightbox.openLightbox({ type: "text", content: "unrelated preview text", filename: "note.txt" });
    }
  }, withLightbox);
}

test.describe("view-harness / Escape never skips an AUQ card", () => {
  test("Escape closes only the topmost lightbox, and still never cancels the card", async ({ page }) => {
    await mountView(page);
    await openCard(page, true);

    const card = page.locator(".prompt-card");
    const overlay = page.locator(".lightbox-overlay");
    await expect(card).toBeVisible();
    await expect(overlay).toBeVisible();

    // First Escape: meant for the image on top. Closes ONLY the lightbox.
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(card).toBeVisible();
    let result = await page.evaluate(() => window.__auqResult);
    expect(result?.cancelled).toBeUndefined();

    // Second Escape: nothing above the card anymore, and it still stays put.
    // The lightbox guard defers a dismissal that no longer exists at all.
    await page.keyboard.press("Escape");
    await expect(card).toBeVisible();
    result = await page.evaluate(() => window.__auqResult);
    expect(result?.cancelled).toBeUndefined();
  });

  test("Escape blurs the focused answer field instead of cancelling", async ({ page }) => {
    await mountView(page);
    await openCard(page, false);

    const card = page.locator(".prompt-card");
    const field = page.locator(".prompt-card__answer-bar textarea");
    await expect(card).toBeVisible();
    await field.focus();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");

    await page.keyboard.press("Escape");

    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA");
    await expect(card).toBeVisible();
    const result = await page.evaluate(() => window.__auqResult);
    expect(result?.cancelled).toBeUndefined();
  });

  test("the Skip button is still the one route to answering nothing", async ({ page }) => {
    await mountView(page);
    await openCard(page, false);

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toBeVisible();

    await page.locator('.prompt-card [data-act="cancel"]').click();

    await expect(card).toHaveCount(0);
    const result = await page.evaluate(() => window.__auqResult);
    expect(result?.cancelled).toBe(true);
  });
});
