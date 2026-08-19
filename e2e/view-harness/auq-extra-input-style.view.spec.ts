import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression: the review step's "add a message" textarea is emitted with class
// `prompt-extra-input`, which the stylesheet never listed, so it rendered
// browser-default (monospace, white border, resize grip) inside the dark card.
// Only reachable with 2+ questions - the extra field lives on the summary step.

test("review step's extra-message textarea picks up the card's input styling", async ({ page }) => {
  await mountView(page);

  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [
        { question: "First?", header: "One", options: [{ label: "A" }] },
        { question: "Second?", header: "Two", options: [{ label: "B" }] },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      supportsExtras: true,
      onSubmit: () => {},
      onCancel: () => {},
    });
  });

  const card = page.locator(".prompt-card");
  const nextArrow = card.locator('.prompt-pager [data-nav="1"]');
  await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("a");
  await nextArrow.click();
  await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("b");
  await nextArrow.click();

  const extra = card.locator(".prompt-extra-input");
  await expect(extra).toBeVisible();

  const style = await extra.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { radius: cs.borderRadius, resize: cs.resize, borderW: cs.borderTopWidth };
  });

  // Radius/resize/border still come only from the .prompt-extra-input rules;
  // the browser default is radius 0 / resize both.
  expect(style.radius).toBe("8px");
  expect(style.resize).toBe("none");
  expect(style.borderW).toBe("1px");

  // The textarea's own background is now transparent by design (composer-core
  // highlight-backdrop adoption, ai_todo composer-unification): the solid
  // surface color moved to the wrapping .cc-typing-wrap div so colored /slash
  // spans can show through the text. Assert the wrapper instead - it's the
  // element that would still render browser-default (transparent) if the
  // stylesheet regressed.
  const wrap = card.locator(".prompt-extra-message .cc-typing-wrap");
  const wrapBg = await wrap.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(wrapBg).not.toBe("rgba(0, 0, 0, 0)");
});
