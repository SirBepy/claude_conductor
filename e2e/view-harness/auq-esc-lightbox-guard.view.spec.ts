import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression for todo 442: Escape meant for an image lightbox atop the AUQ
// card used to cancel the card too on the same keypress, settling it as
// SKIPPED (no answer at all). Drives the real renderQuestionUI + openLightbox
// entry points so this survives the AUQ redesign's render() rewrite.

declare global {
  interface Window {
    // Must stay identical to auq-flow.view.spec.ts's declaration: TS merges
    // global interfaces, and a property declared twice with differing types is
    // an error in whichever file declares it second.
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean; extra?: string };
  }
}

async function openCardThenLightbox(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const questionUi = await import("/views/sessions/permission-modal/question-ui.ts");
    const lightbox = await import("/shared/chat/lightbox.ts");
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
    lightbox.openLightbox({ type: "text", content: "unrelated preview text", filename: "note.txt" });
  });
}

test.describe("view-harness / AUQ Escape vs an open lightbox (todo 442)", () => {
  test("Escape closes only the topmost lightbox, leaving the AUQ card open and unanswered", async ({ page }) => {
    await mountView(page);
    await openCardThenLightbox(page);

    const card = page.locator(".prompt-card");
    const overlay = page.locator(".lightbox-overlay");
    await expect(card).toBeVisible();
    await expect(overlay).toBeVisible();

    // First Escape: meant for the image on top. Must close ONLY the lightbox.
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(card).toBeVisible();
    let result = await page.evaluate(() => window.__auqResult);
    expect(result?.cancelled).toBeUndefined();

    // Second Escape: no overlay above it anymore, so the card now cancels
    // normally - the guard defers the dismissal, it doesn't swallow it forever.
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    result = await page.evaluate(() => window.__auqResult);
    expect(result?.cancelled).toBe(true);
  });

  test("Escape with no lightbox open cancels the AUQ card as before (no regression)", async ({ page }) => {
    await mountView(page);
    await page.evaluate(async () => {
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
    });

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    const result = await page.evaluate(() => window.__auqResult);
    expect(result?.cancelled).toBe(true);
  });
});
