// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (question-card-ask): the Ask panel and its strip/dial entries are gone, a question card's Ask (shown only in Dashboard view) minimizes the card and opens a thread in the Answers card, and the thread classes moved from ask-* to ax-*; nothing this spec asserts changed, and it passes.
// asserts: src/shared/question-icon.ts, src/views/sessions/permission-modal/question-ui-render.ts
// The question card's icon is a chat bubble with a question mark stacked inside
// it, drawn by the live question card; the Answers card keeps the dotted bubble.
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

test("the live question card draws a question mark inside a chat bubble", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  });
  const icon = page.locator(".prompt-card__title .q-icon");
  await expect(icon).toHaveCount(1);
  await expect(icon.locator(".ph-chat-circle")).toHaveCount(1);
  await expect(icon.locator(".ph-question-mark")).toHaveCount(1);
  await expect(page.locator(".prompt-card__title .ph-chat-circle-dots")).toHaveCount(0);

  // Stacked, not side by side: the mark's box sits inside the bubble's box.
  const bubble = (await icon.locator(".ph-chat-circle").boundingBox())!;
  const mark = (await icon.locator(".ph-question-mark").boundingBox())!;
  expect(mark.x).toBeGreaterThanOrEqual(bubble.x - 1);
  expect(mark.y).toBeGreaterThanOrEqual(bubble.y - 1);
  expect(mark.x + mark.width).toBeLessThanOrEqual(bubble.x + bubble.width + 1);
  expect(mark.y + mark.height).toBeLessThanOrEqual(bubble.y + bubble.height + 1);
});
