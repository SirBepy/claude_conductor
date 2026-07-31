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
      titleText: "Claude is asking",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      supportsExtras: true,
      onSubmit: () => {},
      onCancel: () => {},
    });
  });

  const card = page.locator(".prompt-card");
  await card.locator(".prompt-q__other-input").fill("a");
  await card.locator('[data-act="next"]').click();
  await card.locator(".prompt-q__other-input").fill("b");
  await card.locator('[data-act="review"]').click();

  const extra = card.locator(".prompt-extra-input");
  await expect(extra).toBeVisible();

  const style = await extra.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { radius: cs.borderRadius, resize: cs.resize, bg: cs.backgroundColor, borderW: cs.borderTopWidth };
  });

  // All four come only from the .prompt-extra-input rules; the browser default
  // is radius 0 / resize both / transparent background.
  expect(style.radius).toBe("8px");
  expect(style.resize).toBe("none");
  expect(style.borderW).toBe("1px");
  expect(style.bg).not.toBe("rgba(0, 0, 0, 0)");
});
