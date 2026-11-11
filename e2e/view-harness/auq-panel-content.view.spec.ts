// Reviewed 2026-11-11: the Undo hold on sends and card answers is gone (a send or answer goes out at once); nothing this spec asserts depends on it, and it passes.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-22: the phone question card became a fullscreen page (header back arrow + "Question" label and an answer-box send arrow, all hidden on desktop; back collapses the card to its bar instead of falling through) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-08: question-ui.ts's confirmQuestionRendered now also threads the prompt's sessionId to confirm_question_rendered (multi-machine prompt routing, docs/multi-machine.md) - additive, no UI-behavior change for this spec's contract.
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

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
  for (const [i, expected] of expectedTexts.entries()) {
    const panel = panels.nth(i);
    await expect(panel.locator(".prompt-q__text")).toHaveText(expected);
  }

  // Only panel 0 is active - panels 1 and 2 are real content the user never
  // navigated to, exactly what a virtualized rebuild would have left blank.
  await expect(panels.nth(0)).toHaveClass(/is-active/);
  await expect(panels.nth(1)).not.toHaveClass(/is-active/);
  await expect(panels.nth(2)).not.toHaveClass(/is-active/);

  // The answer bar mirrors panel 0 (the active one) without any navigation.
  await expect(card.locator(".prompt-card__answer-bar .prompt-q__other-input")).toBeAttached();
});
