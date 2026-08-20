import { test, expect } from "@playwright/test";
import { mountView, openAnswerBar } from "./harness";

// Regression gate: the horizontal track's whole point is that a drag/swipe
// between questions must reveal real content, never a blank shell - a prior
// implementation only rendered the ACTIVE panel's zone content, leaving every
// other `.prompt-panel` empty. This must fail if virtualization is
// reintroduced: mount 3 questions and assert every panel's own question text
// exists WITHOUT any navigation away from panel 0. The free-text answer input
// itself lives outside the panels now, in the fixed `.prompt-card__answer-bar`
// (one shared field synced to the active tab - see question-ui-render.ts's
// syncAnswerBar), so it's asserted separately, not per panel.

test("mounting a 3-question card renders every panel's real content, not just the active one", async ({ page }) => {
  await mountView(page);

  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [
        { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
        { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
        { question: "Anything else?", header: "Notes", options: [{ label: "Nope" }] },
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

  const panels = card.locator(".prompt-panel");
  // 3 questions + a trailing summary panel (multiple questions => a summary
  // step exists), all present in the DOM without any navigation.
  await expect(panels).toHaveCount(4);

  const expectedTexts = ["Which approach?", "Which features?", "Anything else?"];
  for (let i = 0; i < expectedTexts.length; i++) {
    const panel = panels.nth(i);
    await expect(panel.locator(".prompt-q__text")).toHaveText(expectedTexts[i]);
  }

  // Only panel 0 is active - panels 1 and 2 are real content the user never
  // navigated to, exactly what a virtualized rebuild would have left blank.
  await expect(panels.nth(0)).toHaveClass(/is-active/);
  await expect(panels.nth(1)).not.toHaveClass(/is-active/);
  await expect(panels.nth(2)).not.toHaveClass(/is-active/);

  // The answer bar mirrors panel 0 (the active one) without any panel
  // navigation - opening the (closed-by-default) toggle isn't a panel move.
  await openAnswerBar(card);
  await expect(card.locator(".prompt-card__answer-bar .prompt-q__other-input")).toBeAttached();
});
