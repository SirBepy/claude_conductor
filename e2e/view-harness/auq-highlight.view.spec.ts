// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-22: the phone question card became a fullscreen page (header back arrow + "Question" label and an answer-box send arrow, all hidden on desktop; back collapses the card to its bar instead of falling through) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-08: question-ui.ts's confirmQuestionRendered now also threads the prompt's sessionId to confirm_question_rendered (multi-machine prompt routing, docs/multi-machine.md) - additive, no UI-behavior change for this spec's contract.
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// AUQ colored /slash-token highlighting (ai_todo composer-unification): the
// per-question free-text field now gets the same highlight backdrop the main
// composer uses (via the shared composer-core), not just the "/" suggestion
// popup that landed earlier (fc2c0d75). A typed "/skill-name" that resolves
// to a known user-skill should paint a purple cm-slash-user-skill span in the
// backdrop behind the (now transparent-text) textarea.

const SLASH_ENTRIES = [
  { name: "close", args: null, description: "Session retrospective", source: { kind: "user-skill" } },
];

test("typing a known /skill in the AUQ free-text field renders a purple cm-slash span in the highlight backdrop", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: SLASH_ENTRIES } });

  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] }],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  });

  const card = page.locator(".prompt-card");
  const input = card.locator(".prompt-q__other-input");
  await input.fill("/close");

  const highlight = card.locator(".prompt-card__answer-bar .composer-highlight");
  const span = highlight.locator(".cm-slash-user-skill");
  await expect(span).toHaveCount(1);
  await expect(span).toHaveText("/close");

  // The real textarea's own text must be transparent (backdrop technique) -
  // otherwise the colored span behind it would be invisible/redundant.
  const textColor = await input.evaluate((el) => getComputedStyle(el).color);
  expect(textColor).toBe("rgba(0, 0, 0, 0)");
});
