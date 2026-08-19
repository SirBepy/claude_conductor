import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// AUQ "/" skill-suggestion popup (Joe's request: "when writing in the AUQ
// card, I wanna see skills suggestion, the same way we do it in normal
// chat"). Reuses shared/chat/caret-popup/{popup,providers/slash}.ts verbatim
// (same class the composer wires up), so this exercises the AUQ-specific
// integration in question-ui.ts: anchor positioning, and the keydown wiring
// that must NOT let a popup-consumed Escape also bubble to the card's own
// Escape-cancels-the-whole-card handler.

const SLASH_ENTRIES = [
  { name: "close", args: null, description: "Session retrospective", source: { kind: "user-skill" } },
  { name: "commit", args: null, description: "Commit changes", source: { kind: "user-skill" } },
];

async function openCard(page: import("@playwright/test").Page, opts: { supportsExtras?: boolean; twoQuestions?: boolean } = {}): Promise<void> {
  const { supportsExtras = false, twoQuestions = false } = opts;
  await page.evaluate(async ({ supportsExtras, twoQuestions }) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    const questions = twoQuestions
      ? [
          { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
          { question: "Anything else?", header: "Notes", options: [{ label: "Nope" }] },
        ]
      : [
          { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
        ];
    mod.renderQuestionUI({
      questions,
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      supportsExtras,
      onSubmit: () => {},
      onCancel: () => {},
    });
  }, { supportsExtras, twoQuestions });
}

test.describe("view-harness / AUQ slash-suggestion popup", () => {
  test("typing / in the per-question free-text field shows suggestions, picking one inserts the command", async ({ page }) => {
    await mountView(page, { invoke: { list_slash_commands: SLASH_ENTRIES } });
    await openCard(page);

    const card = page.locator(".prompt-card");
    const input = card.locator(".prompt-q__other-input");
    await input.fill("/cl");

    const popup = card.locator(".caret-popup");
    await expect(popup).toBeVisible();
    await expect(popup.locator(".row")).toHaveCount(1);
    await expect(popup.locator(".row .head")).toHaveText("/close");

    await popup.locator(".row").click();
    await expect(input).toHaveValue("/close ");
    await expect(popup).toBeHidden();
  });

  test("Escape closes only the popup, not the whole card", async ({ page }) => {
    await mountView(page, { invoke: { list_slash_commands: SLASH_ENTRIES } });
    await openCard(page);

    const card = page.locator(".prompt-card");
    const input = card.locator(".prompt-q__other-input");
    await input.fill("/c");
    await expect(card.locator(".caret-popup")).toBeVisible();

    await input.press("Escape");
    await expect(card.locator(".caret-popup")).toBeHidden();
    // The card itself must still be up - a real regression here would have
    // the document-level Escape-cancels-card handler also fire.
    await expect(card).toBeVisible();
  });

  test("ArrowDown/Enter picks the highlighted suggestion", async ({ page }) => {
    await mountView(page, { invoke: { list_slash_commands: SLASH_ENTRIES } });
    await openCard(page);

    const card = page.locator(".prompt-card");
    const input = card.locator(".prompt-q__other-input");
    // "comm" (not "co") - fuzzy subsequence matching means "co" matches both
    // "close" and "commit", which would make this test's "exactly one
    // suggestion" premise flaky.
    await input.fill("/comm");
    const popup = card.locator(".caret-popup");
    await expect(popup.locator(".row")).toHaveCount(1);
    await expect(popup.locator(".row .head")).toHaveText("/commit");

    await input.press("Enter");
    await expect(input).toHaveValue("/commit ");
    await expect(popup).toBeHidden();
    // Enter without a modifier must not have also submitted/advanced the card.
    await expect(card.locator(".prompt-q__text")).toHaveText("Which approach?");
  });

  test("also works on the review-step additional-message field", async ({ page }) => {
    await mountView(page, { invoke: { list_slash_commands: SLASH_ENTRIES } });
    await openCard(page, { supportsExtras: true, twoQuestions: true });

    const card = page.locator(".prompt-card");
    const nextArrow = card.locator('.prompt-pager [data-nav="1"]');
    // Answer both questions via free text, no option clicks, then reach the
    // summary/review screen where the extra-message field lives.
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A");
    await nextArrow.click();
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("done");
    await nextArrow.click();

    const extraInput = card.locator(".prompt-extra-input");
    await expect(extraInput).toBeVisible();
    await extraInput.fill("remember to /cl");

    // The popup mounts as a child of its textarea's `.prompt-q__other` anchor,
    // which now lives in the fixed answer bar, not the (summary) panel.
    const popup = card.locator(".prompt-card__answer-bar .caret-popup");
    await expect(popup).toBeVisible();
    await popup.locator(".row").click();
    await expect(extraInput).toHaveValue("remember to /close ");
  });
});
