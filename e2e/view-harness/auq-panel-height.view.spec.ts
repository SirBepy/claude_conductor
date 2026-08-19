import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression gate: the horizontal track is a single flex row containing every
// question's panel side by side. Flexbox's auto cross-size is the TALLEST
// sibling's height, so a short 2-option question sitting next to a long,
// many-option one used to render as tall as the long one even while parked
// on its own short panel - reported as "the card looks funny, too tall for a
// simple question" (see question-ui.ts's track-height sync). Assert the card
// is meaningfully shorter on the short panel than on the long one.

test("a short question's card height is not stretched to match a longer sibling panel", async ({ page }) => {
  await mountView(page);

  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    const longOptions = Array.from({ length: 8 }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: "A fairly long description line to pad this option's rendered height out.",
    }));
    mod.renderQuestionUI({
      questions: [
        { question: "Quick pick?", header: "Quick", options: [{ label: "A" }, { label: "B" }] },
        { question: "Long one with many options?", header: "Long", options: longOptions },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  });

  const card = page.locator(".prompt-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Quick pick?");

  const shortHeight = (await card.boundingBox())!.height;

  await card.locator('.prompt-dot[data-dot="1"]').click();
  await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Long one with many options?");
  const longHeight = (await card.boundingBox())!.height;

  // The long panel is tall enough to hit the card's max-height cap (80vh on
  // this viewport) and scroll internally - so the two heights don't scale
  // linearly with content. The regression this guards against is the short
  // panel getting stretched up to that same cap; assert it stays well clear
  // of it and strictly shorter than the long panel's (capped) height.
  expect(shortHeight).toBeLessThan(longHeight * 0.8);
});
