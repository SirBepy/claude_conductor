// Reviewed 2026-11-11: the Undo hold on sends and card answers is gone (a send or answer goes out at once); nothing this spec asserts depends on it, and it passes.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-22: the phone question card became a fullscreen page (header back arrow + "Question" label and an answer-box send arrow, all hidden on desktop; back collapses the card to its bar instead of falling through) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-08: question-ui.ts's confirmQuestionRendered now also threads the prompt's sessionId to confirm_question_rendered (multi-machine prompt routing, docs/multi-machine.md) - additive, no UI-behavior change for this spec's contract.
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression: the review step's "add a message" textarea once rendered
// browser-default (monospace, white border, resize grip) inside the dark card.
// It is now the shared composer field (composer-field.ts), so it must carry
// the chat composer's own look - minus its paper-plane, since review's one
// Submit button is the only way forward. It sits behind an "Add a note" row.
// Only reachable with 2+ questions - the extra field lives on the summary step.

async function openReviewNote(page: import("@playwright/test").Page) {
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

  await card.locator('[data-act="add-note"]').click();
  const extra = card.locator(".prompt-summary__note .prompt-extra-input");
  await expect(extra).toBeVisible();
  return { card, extra };
}

test("review step's extra-message textarea is the shared composer field", async ({ page }) => {
  await mountView(page);
  const { card, extra } = await openReviewNote(page);

  const style = await extra.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { radius: cs.borderRadius, resize: cs.resize, borderW: cs.borderTopWidth };
  });

  // composer.css's .composer-textarea values; the browser default is
  // radius 0 / resize both.
  expect(style.radius).toBe("4px");
  expect(style.resize).toBe("none");
  expect(style.borderW).toBe("1px");

  // The textarea is transparent so the highlight backdrop shows through; the
  // surface fill lives on .composer-input-wrap, which would render
  // transparent if the stylesheet regressed.
  const wrap = card.locator(".prompt-summary__note .composer-input-wrap");
  const wrapBg = await wrap.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(wrapBg).not.toBe("rgba(0, 0, 0, 0)");
  await expect(card.locator(".prompt-summary__note .composer-field-send")).toHaveCount(0);
});

// Regression: the box spans the review panel's full width, and composer.css
// draws its 2px focus ring outside the border, so .prompt-panel/
// .prompt-track-viewport's clip shaved the ring off its sides and bottom.
test("review step's extra-message focus ring stays inside the panel's clip", async ({ page }) => {
  await mountView(page);
  const { extra } = await openReviewNote(page);
  await extra.focus();

  const fit = await extra.evaluate((el) => {
    const cs = getComputedStyle(el);
    const reach = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
    const r = el.getBoundingClientRect();
    const ring = { left: r.left - reach, right: r.right + reach, bottom: r.bottom + reach };
    const clips = [el.closest(".prompt-panel"), el.closest(".prompt-track-viewport")]
      .map((c) => c!.getBoundingClientRect());
    return {
      outlineStyle: cs.outlineStyle,
      overflows: clips.map((c) => ({
        left: c.left - ring.left,
        right: ring.right - c.right,
        bottom: ring.bottom - c.bottom,
      })),
    };
  });

  expect(fit.outlineStyle).toBe("solid");
  for (const o of fit.overflows) {
    expect(o.left).toBeLessThanOrEqual(0);
    expect(o.right).toBeLessThanOrEqual(0);
    expect(o.bottom).toBeLessThanOrEqual(0);
  }
});
