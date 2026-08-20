import { test, expect } from "@playwright/test";
import { mountView, openAnswerBar } from "./harness";

// Shared, gitignored, session-agnostic - never a live session's <pid>-<ticks> folder.
const SHOTS = ".for_bepy/screenshots/_specs";

// Todo 602: visual capture only, no assertions beyond "it rendered" - the
// screenshots are the deliverable (commit 6a04d431 pinned the answer bar
// below the scrolling body via .prompt-card__answer-bar; see host.ts).

test("answer bar stays visible below scrolled option content", async ({ page }) => {
  await mountView(page);

  const longOptions = Array.from({ length: 10 }, (_, i) => ({
    label: `Option ${i + 1}`,
    description: "A fairly long description line to pad this option's rendered height out so the body scrolls.",
  }));
  await page.evaluate(async (opts) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [{
        question: "Which of these many options fits best for the long-running migration plan?",
        header: "Migration approach",
        domain: "arch",
        options: opts,
      }],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  }, longOptions);

  const card = page.locator(".prompt-card");
  await expect(card).toBeVisible();

  await openAnswerBar(card);
  const freeText = card.locator(".prompt-q__other-input");
  await freeText.fill("My own typed answer to prove the field stays reachable");

  await card.screenshot({
    path: `${SHOTS}/auq-answer-bar-unscrolled.png`,
  });

  await card.locator(".prompt-card__body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await card.screenshot({
    path: `${SHOTS}/auq-answer-bar-scrolled.png`,
  });

  const barBox = (await card.locator(".prompt-card__answer-bar").boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(barBox.y).toBeGreaterThanOrEqual(cardBox.y);
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 1);
});
