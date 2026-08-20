import { test, expect } from "@playwright/test";
import { mountView, openAnswerBar } from "./harness";

// AUQ horizontal-track flow: every question is a real, always-rendered panel
// in a scroll-snap track with a dot pager and caret arrows - no Next/Review/
// Back buttons, no `.prompt-tab` screens (those were retired). Exercises
// renderQuestionUI directly (dynamic import of the dev-served module) so no
// session/composer mount or daemon is needed - ensureHost() falls back to a
// viewport-fixed card when neither .session-composer nor .session-pane exist.
//
// Locators are scoped to `.prompt-panel.is-active` (or `.nth(i)`) throughout:
// since panels are never virtualized, a bare `.prompt-q__text` etc. matches
// every question's panel at once and trips Playwright strict mode. The
// free-text input lives outside the panel, in the fixed `.prompt-card__answer-bar`
// (synced to whichever tab is active), so it's addressed via `card` instead.

declare global {
  interface Window {
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean };
    __auqDraftChanges?: Array<{ freeText: [number, string][]; selections: [number, string | string[]][]; activeTab: number }>;
  }
}

async function openCard(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    window.__auqDraftChanges = [];
    mod.renderQuestionUI({
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          options: [{ label: "A" }, { label: "B" }],
        },
        {
          question: "Which features?",
          header: "Features",
          multiSelect: true,
          options: [{ label: "X" }, { label: "Y" }],
        },
        {
          question: "Anything else?",
          header: "Notes",
          options: [{ label: "Nope" }],
        },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers) => { window.__auqResult!.submitted = answers; },
      onCancel: () => { window.__auqResult!.cancelled = true; },
      // Maps/Sets don't structured-clone across the page.evaluate boundary
      // cleanly for later inspection, so flatten to plain arrays here.
      onDraftChange: (draft) => {
        window.__auqDraftChanges!.push({
          freeText: Array.from(draft.freeText.entries()),
          selections: Array.from(draft.selections.entries()).map(([k, v]) => [k, v instanceof Set ? Array.from(v) : v]),
          activeTab: draft.activeTab,
        });
      },
    });
  });
}

test.describe("view-harness / AUQ horizontal-track pager flow", () => {
  test("answering via free text alone (no option click) still counts as answered", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    const activePanel = card.locator(".prompt-panel.is-active");
    await expect(activePanel.locator(".prompt-q__text")).toHaveText("Which approach?");

    const arrow = card.locator('.prompt-pager [data-nav="1"]');
    await expect(arrow).toBeDisabled();
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("Go with plan A, typed not clicked");
    await expect(arrow).toBeEnabled();
    await expect(card.locator('.prompt-dot[data-dot="0"]')).toHaveClass(/is-answered/);
  });

  test("dot pager: clicking a dot scrolls to that panel; current and answered classes are independent", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    const dot0 = card.locator('.prompt-dot[data-dot="0"]');
    const dot1 = card.locator('.prompt-dot[data-dot="1"]');

    // Dot 0 starts current but unanswered - the two classes aren't linked.
    await expect(dot0).toHaveClass(/is-current/);
    await expect(dot0).not.toHaveClass(/is-answered/);

    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A");
    // Now both classes apply to the same dot at once.
    await expect(dot0).toHaveClass(/is-current/);
    await expect(dot0).toHaveClass(/is-answered/);

    await dot1.click();
    await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Which features?");
    await expect(dot1).toHaveClass(/is-current/);
    await expect(dot0).not.toHaveClass(/is-current/);
    // Dot 0's fill (answered) persists after moving away from it.
    await expect(dot0).toHaveClass(/is-answered/);
  });

  test("arrows are disabled at the first/last panel; three rapid clicks advance three panels via a tracked index", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    const prevArrow = card.locator('.prompt-pager [data-nav="-1"]');
    const nextArrow = card.locator('.prompt-pager [data-nav="1"]');
    await expect(prevArrow).toBeDisabled();

    // Answer all three questions via dot-jumps (not the arrow) so every
    // forward arrow click below is unlocked, then return to panel 0.
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A");
    await card.locator('.prompt-dot[data-dot="1"]').click();
    await card.locator('.prompt-panel.is-active .prompt-q__opts input[data-label="X"]').check();
    await card.locator('.prompt-dot[data-dot="2"]').click();
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("done");
    await card.locator('.prompt-dot[data-dot="0"]').click();
    await expect(card.locator(".prompt-panel.is-active")).toHaveAttribute("data-panel", "0");

    // Three back-to-back clicks must land on panel 3 (the summary), not get
    // stuck at 1 - the index is a plain counter, never read back mid-animation.
    await nextArrow.click();
    await nextArrow.click();
    await nextArrow.click();

    await expect(card.locator(".prompt-panel.is-active")).toHaveAttribute("data-panel", "3");
    await expect(nextArrow).toBeDisabled();
  });

  test("the trailing summary panel lists every answer; clicking a row jumps back to that question's panel", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A (typed)");
    await card.locator('.prompt-dot[data-dot="1"]').click();
    await card.locator('.prompt-panel.is-active .prompt-q__opts input[data-label="X"]').check();
    await card.locator('.prompt-dot[data-dot="2"]').click();
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("nothing else");
    await card.locator('.prompt-dot[data-dot="3"]').click();

    const summaryPanel = card.locator(".prompt-panel.is-active");
    const rows = summaryPanel.locator(".prompt-summary-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator(".prompt-summary-row__answer")).toHaveText("A (typed)");
    await expect(rows.nth(1).locator(".prompt-summary-row__answer")).toHaveText("X");
    await expect(rows.nth(2).locator(".prompt-summary-row__answer")).toHaveText("nothing else");

    await rows.nth(1).click();
    await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Which features?");
  });

  test("submit stays disabled until every question is answered; the submitted payload is keyed by question text", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    // Dots aren't gated, so jump straight to review (dot 3) with nothing
    // answered yet - the primary button there is Submit, disabled until every
    // question is answered, regardless of how review was reached.
    await card.locator('.prompt-dot[data-dot="3"]').click();
    const primaryBtn = card.locator('[data-act="primary"]');
    await expect(primaryBtn).toHaveText(/Submit/);
    await expect(primaryBtn).toBeDisabled();

    await card.locator('.prompt-summary-row').nth(0).click();
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A (typed)");
    await card.locator('.prompt-dot[data-dot="3"]').click();
    await expect(primaryBtn).toBeDisabled();

    await card.locator('.prompt-summary-row').nth(1).click();
    await card.locator('.prompt-panel.is-active .prompt-q__opts input[data-label="X"]').check();
    await card.locator('.prompt-dot[data-dot="3"]').click();
    await expect(primaryBtn).toBeDisabled();

    await card.locator('.prompt-summary-row').nth(2).click();
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("nothing else");
    await card.locator('.prompt-dot[data-dot="3"]').click();
    await expect(primaryBtn).toBeEnabled();

    await primaryBtn.click();
    const result = await page.evaluate(() => window.__auqResult);
    expect(result?.submitted).toEqual({
      "Which approach?": "A (typed)",
      "Which features?": ["X"],
      "Anything else?": "nothing else",
    });
    await expect(card).toHaveCount(0);
  });

  test("footer primary button reads Next and Submit is absent on every question panel; only review shows Submit", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    const primaryBtn = card.locator('[data-act="primary"]');
    await expect(primaryBtn).toHaveText(/Next/);
    await expect(primaryBtn).toBeDisabled();
    await expect(card.locator('[data-act="submit"]')).toHaveCount(0);

    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A (typed)");
    await expect(primaryBtn).toBeEnabled();
    await primaryBtn.click();

    // Now on question 2 of 3 - still Next, Submit still absent.
    await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Which features?");
    await expect(primaryBtn).toHaveText(/Next/);
    await expect(card.locator('[data-act="submit"]')).toHaveCount(0);
  });

  test("multiSelect: a real option, 'None of the above', or free text alone all unlock the arrow; None is exclusive", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A");
    await card.locator('.prompt-dot[data-dot="1"]').click();
    await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Which features?");

    const arrow = card.locator('.prompt-pager [data-nav="1"]');
    const panel = card.locator(".prompt-panel.is-active");
    const noneBox = panel.locator('.prompt-opt input[data-label="None of the above"]');
    const xBox = panel.locator('.prompt-opt input[data-label="X"]');
    await expect(noneBox).toBeVisible();
    await expect(arrow).toBeDisabled();

    // A real option unlocks the arrow.
    await xBox.check();
    await expect(arrow).toBeEnabled();

    // "None of the above" is exclusive: picking it clears the real option, and
    // is itself a valid, unlock-worthy answer.
    await noneBox.check();
    await expect(xBox).not.toBeChecked();
    await expect(arrow).toBeEnabled();

    // Picking a real option again clears None back out.
    await xBox.check();
    await expect(noneBox).not.toBeChecked();
    await expect(arrow).toBeEnabled();

    // Unchecking the only selection re-locks the arrow; free text alone also
    // unlocks it, with nothing checked.
    await xBox.uncheck();
    await expect(arrow).toBeDisabled();
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("actually, something else entirely");
    await expect(arrow).toBeEnabled();
  });

  test("Ctrl+Enter advances to the next unanswered panel, lands on review (not a submit) after the last one, and submits from review", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    let activePanel = card.locator(".prompt-panel.is-active");
    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A (typed)");
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").press("Control+Enter");

    activePanel = card.locator(".prompt-panel.is-active");
    await expect(activePanel.locator(".prompt-q__text")).toHaveText("Which features?");

    await activePanel.locator('.prompt-q__opts input[data-label="X"]').check();
    // Tab 1 is answered via the checkbox alone, so its own-words zone was
    // never opened - the shortcut is document-global (question-ui.ts's
    // keydownHandler), so it fires without a focused free-text field.
    await page.keyboard.press("Control+Enter");

    activePanel = card.locator(".prompt-panel.is-active");
    await expect(activePanel.locator(".prompt-q__text")).toHaveText("Anything else?");

    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("nothing else");
    // Last question now answered - Ctrl+Enter advances to review, it does NOT submit.
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").press("Control+Enter");
    await expect(card.locator(".prompt-panel.is-active")).toHaveAttribute("data-panel", "3");
    expect(await page.evaluate(() => window.__auqResult?.submitted)).toBeUndefined();

    // Ctrl+Enter from review submits.
    await page.keyboard.press("Control+Enter");
    const result = await page.evaluate(() => window.__auqResult);
    expect(result?.submitted).toEqual({
      "Which approach?": "A (typed)",
      "Which features?": ["X"],
      "Anything else?": "nothing else",
    });
    await expect(card).toHaveCount(0);
  });

  test("onDraftChange fires with the live draft as the user types and navigates (persistence + chat-sync feed off this)", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    // Fires once on the initial render too, with an empty draft - except Q2
    // (multiSelect) gets a pre-seeded empty Set so its checkboxes have
    // something to mutate, per the existing multiSelect init in renderQuestionUI.
    let changes = await page.evaluate(() => window.__auqDraftChanges);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.at(-1)).toEqual({ freeText: [], selections: [[1, []]], activeTab: 0 });

    await openAnswerBar(card);
    await card.locator(".prompt-card__answer-bar .prompt-q__other-input").fill("A (typed)");
    changes = await page.evaluate(() => window.__auqDraftChanges);
    expect(changes.at(-1)).toEqual({ freeText: [[0, "A (typed)"]], selections: [[1, []]], activeTab: 0 });

    await card.locator('.prompt-dot[data-dot="1"]').click();
    changes = await page.evaluate(() => window.__auqDraftChanges);
    // Jumping via the dot re-renders, so activeTab moves to 1, freeText kept.
    expect(changes.at(-1)).toEqual({ freeText: [[0, "A (typed)"]], selections: [[1, []]], activeTab: 1 });

    await card.locator('.prompt-panel.is-active .prompt-q__opts input[data-label="X"]').check();
    changes = await page.evaluate(() => window.__auqDraftChanges);
    expect(changes.at(-1)).toEqual({ freeText: [[0, "A (typed)"]], selections: [[1, ["X"]]], activeTab: 1 });
  });
});
