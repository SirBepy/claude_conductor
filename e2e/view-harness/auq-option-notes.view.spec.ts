// asserts: src/views/sessions/permission-modal/question-ui-templates.ts, src/views/sessions/permission-modal/question-ui-render.ts, src/views/sessions/permission-modal/question-ui-answer-bar.ts, src/views/sessions/permission-modal-shell.css, src/views/sessions/permission-modal-question.css
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Joe, 2026-10-26: a pencil on each ticked option opens a note box under it,
// the desktop answer box loses its own send arrow (Next is the one way
// forward), and review's Submit is a capped CTA with an "Add a note" row.

declare global {
  interface Window { __auqSubmitted?: { answers: Record<string, string | string[]>; extra: string } }
}

async function openCard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 820 });
  await mountView(page);
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [
        { question: "Which sections?", header: "Sections", multiSelect: true, options: [{ label: "Top strip" }, { label: "Kalendar" }] },
        { question: "Range?", header: "Range", options: [{ label: "6 months" }, { label: "12 months" }] },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      supportsExtras: true,
      onSubmit: (answers, extras) => { window.__auqSubmitted = { answers, extra: extras.additionalMessage }; },
      onCancel: () => {},
    });
  });
}

test("desktop: notes on ticked options ride in the answer; review is one normal-width Submit", async ({ page }) => {
  await openCard(page);
  const card = page.locator(".prompt-card");
  const active = card.locator(".prompt-panel.is-active");

  await expect(card.locator(".prompt-card__answer-bar textarea")).toBeVisible();
  await expect(card.locator(".prompt-card__answer-bar .composer-field-send")).toHaveCount(0);
  await expect(card.locator("[data-note-toggle]")).toHaveCount(0);

  await active.locator('input[data-label="Top strip"]').click();
  const pencil = active.locator('[data-note-toggle="Top strip"]');
  await expect(pencil).toBeVisible();
  // Tapping the pencil must not untick the option it sits inside.
  await pencil.click();
  await expect(active.locator('input[data-label="Top strip"]')).toBeChecked();
  const note = active.locator(".prompt-opt__note-input");
  await expect(note).toBeFocused();
  await page.keyboard.type("feels meh");
  await expect(active.locator('input[data-label="Top strip"]')).toBeChecked();

  await card.locator('[data-act="primary"]').click();
  await card.locator('.prompt-panel.is-active input[data-label="6 months"]').click();
  await card.locator('[data-act="primary"]').click();

  const review = card.locator(".prompt-panel.is-active .prompt-summary");
  await expect(review.locator(".prompt-summary-row__note")).toHaveText("Top strip: feels meh");
  const submit = card.locator('.prompt-card__footer [data-act="primary"]');
  const box = (await submit.boundingBox())!;
  const footer = (await card.locator(".prompt-card__footer").boundingBox())!;
  // Normal button width on desktop (Joe, 2026-10-27: the 280px CTA read as too big).
  expect(box.width).toBeLessThan(160);
  // Right-aligned, where Next sat on the steps before.
  expect(footer.x + footer.width - (box.x + box.width)).toBeLessThan(20);

  await review.locator('[data-act="add-note"]').click();
  await expect(review.locator(".prompt-extra-input")).toBeFocused();
  await page.keyboard.type("one more");
  await submit.click();

  const sent = await page.evaluate(() => window.__auqSubmitted);
  expect(sent?.answers["Which sections?"]).toEqual(["Top strip (note: feels meh)"]);
  expect(sent?.extra).toBe("one more");
});
