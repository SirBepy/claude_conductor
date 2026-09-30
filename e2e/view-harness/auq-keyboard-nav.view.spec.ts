import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Keyboard answering for the AUQ card (question-keyboard.ts): Tab from a text
// box enters the options, Up/Down move, Space toggles without advancing,
// Enter mirrors the Next/Submit button (picking the highlighted option first
// on an unanswered single-select), Left/Right page freely, and typing a letter on an
// option lands it in the answer box.

declare global {
  interface Window {
    // Must stay identical to auq-flow.view.spec.ts's declaration (TS2717).
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean; extra?: string };
  }
}

async function openCard(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    mod.renderQuestionUI({
      questions: [
        { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
        { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers) => { window.__auqResult!.submitted = answers; },
      onCancel: () => { window.__auqResult!.cancelled = true; },
    });
  });
}

const focusedLabel = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.label ?? null);
const activeTab = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(document.querySelector<HTMLElement>(".prompt-panel.is-active")?.dataset.panel));
const focusedIsAnswerField = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.activeElement?.matches(".prompt-card__answer-bar textarea") ?? false);

test.describe("view-harness / AUQ keyboard navigation", () => {
  test("Tab, arrows, Space and Enter answer the whole card", async ({ page }) => {
    await mountView(page);
    await openCard(page);
    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();

    await card.locator(".prompt-card__answer-bar textarea").focus();
    await page.keyboard.press("Tab");
    expect(await focusedLabel(page)).toBe("A");

    await page.keyboard.press("ArrowDown");
    expect(await focusedLabel(page)).toBe("B");

    // Space picks without advancing, and focus survives the re-render.
    await page.keyboard.press(" ");
    await expect(card.locator('.prompt-panel.is-active input[data-label="B"]')).toBeChecked();
    expect(await activeTab(page)).toBe(0);
    expect(await focusedLabel(page)).toBe("B");

    // Enter = Next, focus follows into the next question's options.
    await page.keyboard.press("Enter");
    await expect.poll(() => activeTab(page)).toBe(1);
    expect(await focusedLabel(page)).toBe("X");

    await page.keyboard.press(" ");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press(" ");
    await expect(card.locator('.prompt-panel.is-active input[data-label="X"]')).toBeChecked();
    await expect(card.locator('.prompt-panel.is-active input[data-label="Y"]')).toBeChecked();

    // Enter to review lands on Submit, so the next Enter sends.
    await page.keyboard.press("Enter");
    await expect.poll(() => activeTab(page)).toBe(2);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-act"))).toBe("primary");
    await page.keyboard.press("Enter");

    const result = await page.evaluate(() => window.__auqResult?.submitted);
    expect(result).toEqual({ "Which approach?": "B", "Which features?": ["X", "Y"] });
  });

  test("Enter on an unanswered single-select picks the highlighted option", async ({ page }) => {
    await mountView(page);
    await openCard(page);
    const card = page.locator(".prompt-card");
    await card.locator(".prompt-card__answer-bar textarea").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect.poll(() => activeTab(page)).toBe(1);
    await expect(card.locator('.prompt-panel[data-panel="0"] input[data-label="C"]')).toBeChecked();
  });

  test("Left/Right page freely, even past unanswered questions and out of review", async ({ page }) => {
    await mountView(page);
    await openCard(page);
    const card = page.locator(".prompt-card");
    await card.locator(".prompt-card__answer-bar textarea").focus();
    await page.keyboard.press("Tab");

    await page.keyboard.press("ArrowRight");
    await expect.poll(() => activeTab(page)).toBe(1);
    expect(await focusedLabel(page)).toBe("X");

    await page.keyboard.press("ArrowRight");
    await expect.poll(() => activeTab(page)).toBe(2);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-act"))).toBe("primary");

    await page.keyboard.press("ArrowRight");
    expect(await activeTab(page)).toBe(2);

    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => activeTab(page)).toBe(1);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => activeTab(page)).toBe(0);
    expect(await focusedLabel(page)).toBe("A");
    await expect(card.locator('.prompt-panel[data-panel="0"] input:checked')).toHaveCount(0);
  });

  test("arrows do nothing while the card is minimized", async ({ page }) => {
    await mountView(page);
    await openCard(page);
    await page.locator('.prompt-card [data-act="minimize"]').click();
    await page.locator('.prompt-collapsed [data-act="restore"]').focus();
    await page.keyboard.press("ArrowRight");
    await page.locator('.prompt-collapsed [data-act="restore"]').click();
    expect(await activeTab(page)).toBe(0);
  });

  test("Down off the last option reaches the answer box, Up from its start returns", async ({ page }) => {
    await mountView(page);
    await openCard(page);
    const card = page.locator(".prompt-card");
    await card.locator(".prompt-card__answer-bar textarea").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await focusedLabel(page)).toBe("C");

    await page.keyboard.press("ArrowDown");
    expect(await focusedIsAnswerField(page)).toBe(true);

    await page.keyboard.press("ArrowUp");
    expect(await focusedLabel(page)).toBe("C");
  });

  test("typing on an option writes into the answer box", async ({ page }) => {
    await mountView(page);
    await openCard(page);
    const card = page.locator(".prompt-card");
    const field = card.locator(".prompt-card__answer-bar textarea");
    await field.fill("Also ");
    await field.focus();
    await page.keyboard.press("Tab");
    expect(await focusedLabel(page)).toBe("A");

    await page.keyboard.type("hi");
    expect(await focusedIsAnswerField(page)).toBe(true);
    await expect(field).toHaveValue("Also hi");
  });
});
