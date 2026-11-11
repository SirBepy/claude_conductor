// Reviewed 2026-11-11: the Undo hold on sends and card answers is gone (a send or answer goes out at once); nothing this spec asserts depends on it, and it passes.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-22: the phone question card became a fullscreen page (header back arrow + "Question" label and an answer-box send arrow, all hidden on desktop; back collapses the card to its bar instead of falling through) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-08: question-ui.ts's confirmQuestionRendered now also threads the prompt's sessionId to confirm_question_rendered (multi-machine prompt routing, docs/multi-machine.md) - additive, no UI-behavior change for this spec's contract.
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression gate for the Android "Submit unreachable" bug: the host never
// referenced env(safe-area-inset-bottom), so a fixed 24px offset let the
// footer sit under the nav bar. Content alone can't overflow this 852px
// viewport (max-height caps it) - the CDP override reproduces the bug.

const INSET = 100;

async function overrideSafeArea(page: import("@playwright/test").Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { bottom: INSET, bottomMax: INSET },
  } as never);
}

async function openContentHeavyCard(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    const manyOptions = Array.from({ length: 12 }, (_, i) => ({
      label: `Option number ${i + 1} with a longer label`,
      description: "A fairly long description line to pad this option's rendered height out.",
    }));
    mod.renderQuestionUI({
      questions: [
        { question: "Which approach should we take, given the constraints?", header: "Approach", options: manyOptions },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  });
}

test("footer stays clear of the safe-area inset on a phone viewport (no host/pane mounted -> --viewport mode)", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await mountView(page);
  await overrideSafeArea(page);
  await openContentHeavyCard(page);

  const footer = page.locator(".prompt-card__footer");
  await expect(footer).toBeVisible();
  const box = (await footer.boundingBox())!;

  // The nav bar covers the bottom INSET px of the 852px viewport - the
  // Submit button must clear that line, not just the raw viewport edge.
  expect(box.y + box.height).toBeLessThanOrEqual(852 - INSET);
});
