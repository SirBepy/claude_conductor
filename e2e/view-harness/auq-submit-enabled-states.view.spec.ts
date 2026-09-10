import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Todo 880: pins the already-deliberate Submit-enabled behaviour documented
// at question-ui-render.ts's updatePrimaryButton (~line 138) - Submit is
// NEVER blocked, unlike Next (which stays gated on answeredAt). An
// unanswered question becomes NO_ANSWER_TEXT in the onSubmit payload instead
// of silently vanishing. This spec only pins the state; the design question
// itself is settled and out of scope (see the todo).
//
// A single-question card has no review/summary panel (hasSummary =
// questions.length > 1), so the lone panel's own Submit button is the one
// under test - no Next/pager gating to route around.

declare global {
  interface Window {
    // Matches auq-flow.view.spec.ts's declaration exactly - `declare global`
    // augmentations for the same property must agree project-wide (TS2717).
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean; extra?: string };
  }
}

async function openSingleQuestionCard(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    mod.renderQuestionUI({
      questions: [
        {
          question: "Pick a colour",
          header: "Colour",
          options: [{ label: "Red" }, { label: "Blue" }],
        },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers) => { window.__auqResult!.submitted = answers; },
      onCancel: () => { window.__auqResult!.cancelled = true; },
    });
  });
}

test.describe("view-harness / AUQ Submit is never gated by selection", () => {
  test("Submit is enabled with nothing selected", async ({ page }) => {
    await mountView(page);
    await openSingleQuestionCard(page);

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    const submitBtn = card.locator('[data-act="primary"]');
    await expect(submitBtn).toBeEnabled();

    // Submitting from this exact state records the deliberate NO_ANSWER_TEXT
    // fallback rather than being blocked or silently dropping the question.
    await submitBtn.click();
    const result = await page.evaluate(() => window.__auqResult?.submitted);
    expect(result).toEqual({ "Pick a colour": "(No answer provided)" });
  });

  test("Submit stays enabled once an option is selected", async ({ page }) => {
    await mountView(page);
    await openSingleQuestionCard(page);

    const card = page.locator(".prompt-card");
    const submitBtn = card.locator('[data-act="primary"]');
    await card.locator('.prompt-opt input[data-label="Blue"]').click();
    await expect(submitBtn).toBeEnabled();

    await submitBtn.click();
    const result = await page.evaluate(() => window.__auqResult?.submitted);
    expect(result).toEqual({ "Pick a colour": "Blue" });
  });

  test("Submit stays enabled once free text is typed (no option clicked)", async ({ page }) => {
    await mountView(page);
    await openSingleQuestionCard(page);

    const card = page.locator(".prompt-card");
    const submitBtn = card.locator('[data-act="primary"]');
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("Teal, not on the list");
    await expect(submitBtn).toBeEnabled();

    await submitBtn.click();
    const result = await page.evaluate(() => window.__auqResult?.submitted);
    expect(result).toEqual({ "Pick a colour": "Teal, not on the list" });
  });
});
