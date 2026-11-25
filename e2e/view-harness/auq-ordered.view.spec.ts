// Reviewed 2026-11-25 (model and effort are words, not battery glyphs; the desktop chat header is one line with one text chip): nothing this spec asserts changed, and it passes in the full view-suite run.
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView } from "./harness";

// asserts: src/views/sessions/permission-modal/question-ui-templates.ts, src/views/sessions/permission-modal/question-state.ts, src/views/sessions/permission-modal-question.css

// An `ordered` question (pc-1751): tap options in sequence to number them, tap a
// numbered one to take it out, leave out what does not belong. Drawn on the
// desktop card and on the phone-width card.

declare global {
  interface Window { __auqOrderedAnswers?: Record<string, string | string[]> }
}

async function openCard(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 820 });
  await mountView(page);
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [
        {
          question: "If the plan is finished, what does the run build first?",
          header: "Build order",
          domain: "arch",
          ordered: true,
          options: [
            { label: "Stage 7: share sheet", description: "Needs the new store." },
            { label: "Stage 8: offline mode" },
            { label: "Polish pass", description: "Copy and spacing only." },
            { label: "Docs" },
          ],
        },
      ],
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      supportsExtras: true,
      onSubmit: (answers) => { window.__auqOrderedAnswers = answers; },
      onCancel: () => {},
    });
  });
}

const QUESTION = "If the plan is finished, what does the run build first?";

for (const [name, width] of [["desktop", 1100], ["phone", 390]] as const) {
  test(`${name}: taps number the options in order, a second tap takes one out, the answer lists the unmarked`, async ({ page }) => {
    await openCard(page, width);
    const card = page.locator(".prompt-card");
    const row = (label: string) => card.locator(".prompt-opt--ordered", { hasText: label });
    const rank = (label: string) => row(label).locator(".prompt-opt__rank");

    await expect(card.locator(".prompt-sect__label")).toContainText("Tap in order");
    await expect(card.locator(".prompt-opt--none")).toHaveCount(0);
    await capture(card, `pc-1751-ordered-${name}-empty`);

    await row("Polish pass").click();
    await row("Stage 7").click();
    await row("Docs").click();
    await expect(rank("Polish pass")).toHaveText("1");
    await expect(rank("Stage 7")).toHaveText("2");
    await expect(rank("Docs")).toHaveText("3");
    await expect(rank("Stage 8")).toHaveText("");
    await capture(card, `pc-1751-ordered-${name}-three-placed`);

    // Taking one out closes the gap.
    await row("Polish pass").click();
    await expect(rank("Stage 7")).toHaveText("1");
    await expect(rank("Docs")).toHaveText("2");
    await expect(rank("Polish pass")).toHaveText("");

    await card.locator('[data-act="primary"]').click();
    const sent = await page.evaluate(() => window.__auqOrderedAnswers);
    expect(sent?.[QUESTION]).toEqual(["1. Stage 7: share sheet", "2. Docs", "Unmarked: Stage 8: offline mode, Polish pass"]);
  });
}

test("keyboard: Space on a focused option places it, like a tap", async ({ page }) => {
  await openCard(page, 1100);
  const card = page.locator(".prompt-card");
  await card.locator('.prompt-opt--ordered input[data-label="Docs"]').focus();
  await page.keyboard.press("Space");
  await expect(card.locator(".prompt-opt--ordered", { hasText: "Docs" }).locator(".prompt-opt__rank")).toHaveText("1");
});
