// Reviewed 2026-11-08: the chip no longer falls into the ask band when there is no context; a chip-only strip above the band keeps it at the context row's chip position (asserted below).
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// Reviewed 2026-10-31: the chip is back on the context row's right (the edge-to-edge zones are asserted in auq-desktop-phone-layout.view.spec.ts).
// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-27: types.ts's QuestionDraft gained an optional per-option `notes` map (AUQ option notes) - additive, no change to this spec's contract.
// Reviewed 2026-10-22: the phone question card became a fullscreen page (header back arrow + "Question" label and an answer-box send arrow, all hidden on desktop; back collapses the card to its bar instead of falling through) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-08: question-ui.ts's confirmQuestionRendered now also threads the prompt's sessionId to confirm_question_rendered (multi-machine prompt routing, docs/multi-machine.md) - additive, no UI-behavior change for this spec's contract.
// Reviewed 2026-10-08: types.ts gained a SecretRequestedPayload interface for the request_secret MCP tool's masked-value card - additive, no change to this spec's question-domain-chip contract.
// Reviewed 2026-10-17: QuestionOption gained an optional `preview` (option-previews.ts) - these questions carry none, so the domain chip and badge contract is unchanged.
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import type { Question } from "../../src/views/sessions/permission-modal/types";

// The domain chip sits at the same spot whether or not the question has a
// Context row: top right of the first row. Badges ride the option rows either way.

const TERSE = {
  question: "Which approach?",
  header: "Approach",
  domain: "arch",
  options: [
    { label: "Rewrite", description: "start clean", badges: ["recommended", "long_term"] },
    { label: "Patch", description: "smallest diff", badges: ["short_term"] },
  ],
} satisfies Question;

const WITH_CONTEXT = {
  ...TERSE,
  question: "The relay drops frames under load. Which approach?",
};

async function mount(page: Page, question: typeof TERSE) {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async (q) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [q],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  }, question);
  return page.locator(".prompt-card");
}

// Chip offset from the card's own top-left, so two cards mounted in turn compare.
async function chipOffset(card: ReturnType<Page["locator"]>) {
  const chip = (await card.locator(".prompt-zone--ctx .prompt-domain").boundingBox())!;
  const frame = (await card.boundingBox())!;
  return { fromRight: frame.x + frame.width - (chip.x + chip.width), fromTop: chip.y - frame.y };
}

test("a terse question shows the domain chip on a chip-only strip above the ask band", async ({ page }) => {
  const card = await mount(page, TERSE);

  await expect(card.locator(".prompt-ctx__label")).toHaveCount(0);
  const chip = card.locator(".prompt-zone--ctx .prompt-domain");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/arch/i);
  await expect(card.locator(".prompt-zone--ask .prompt-domain")).toHaveCount(0);

  const box = (await chip.boundingBox())!;
  const strip = (await card.locator(".prompt-zone--ctx").boundingBox())!;
  const askBox = (await card.locator(".prompt-zone--ask").boundingBox())!;
  expect(box.width).toBeGreaterThan(30);
  expect(box.height).toBeGreaterThan(12);
  expect(box.x).toBeGreaterThan(strip.x + strip.width / 2);
  expect(box.y + box.height).toBeLessThanOrEqual(askBox.y + 1);

  await card.screenshot({
    path: ".for_bepy/screenshots/_specs/auq-domain-chip-terse.png",
  });
});

test("option badges render with their labels", async ({ page }) => {
  const card = await mount(page, TERSE);

  const badges = card.locator(".prompt-opt .prompt-badge");
  await expect(badges).toHaveCount(3);
  await expect(badges.nth(0)).toBeVisible();
  await expect(card.locator(".prompt-badge--rec")).toHaveCount(1);
});

test("a question WITH context keeps the chip on the context row, right-aligned", async ({ page }) => {
  const card = await mount(page, WITH_CONTEXT);

  await expect(card.locator(".prompt-ctx__head .prompt-domain")).toHaveCount(1);
  await expect(card.locator(".prompt-zone--ask .prompt-domain")).toHaveCount(0);

  const head = (await card.locator(".prompt-ctx__head").boundingBox())!;
  const chip = (await card.locator(".prompt-ctx__head .prompt-domain").boundingBox())!;
  expect(chip.x).toBeGreaterThan(head.x + head.width / 2);

  await card.screenshot({
    path: ".for_bepy/screenshots/_specs/auq-domain-chip-context.png",
  });
});

test("the chip lands on the same spot with and without a context row", async ({ page }) => {
  const terse = await chipOffset(await mount(page, TERSE));
  await page.reload();
  const withCtx = await chipOffset(await mount(page, WITH_CONTEXT));

  expect(Math.abs(terse.fromRight - withCtx.fromRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(terse.fromTop - withCtx.fromTop)).toBeLessThanOrEqual(1);
});
