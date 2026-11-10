// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-05: permission-modal/gating.ts and index.ts gained hydrateSubchatsOn/isSubchatsOn/setSubchatsOn (the Use subchats toggle's in-memory state, hydrated at install time) - additive; the harness's unmocked list_subchats_on rejection is caught inside the hydrate, no change to this spec's contract.
// Reviewed 2026-11-02: the question card's header ask button now takes --control-h and its nav arrows --control-h-sm; this spec asserts the layout and passes.
// Reviewed 2026-11-01: the review panel supplies its own top gap now that the card body has none (assertion in the review-step test).
// Reviewed 2026-10-31: the context box and ask band run edge to edge on desktop too (new test below); the chip moved back to the context row.
// Reviewed 2026-10-30: the question card's ask band is now two rows (domain chip + Ask button on top, question text under them) and the ? icon is gone - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-29: .icon-btn-sq now sets place-content: center beside place-items, and the question card's Ask button uses display: grid instead of inline-flex, so its glyph is centred - no change to this spec's contract, and it passes.
// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/permission-modal-shell.css, src/views/sessions/permission-modal/question-ui-answer-bar.ts
// Reviewed 2026-10-28: the phone review Submit's 48px min-height now wins over the footer's 32px button rule - phone-media only, no change to this desktop spec's contract.
// Reviewed 2026-10-28: the phone page's ask band now runs edge to edge (track viewport widened over the body padding, panels re-inset) - phone-media only, no change to this spec's contract.
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";
import { shotDir } from "./shot-dir";

// The desktop question card copies the phone's layout: Ask sits on the
// question band, the answer box's arrow is Next/Submit and the footer's own
// buttons stay hidden while the box is up. Two exceptions keep a button: the
// review step (its Submit is the step's only control) and the --viewport
// fallback host (no pane to dock to, so it keeps the footer button and has no
// arrow). Mounts the real sessions view at a desktop width so the card lands
// in --composer mode, and shoots both cards for a human to look at.

const DESKTOP = { width: 1280, height: 800 };
const SHOTS = shotDir();
const SESSION = sessionInstance();

const SINGLE = [{
  question: "Which approach fits the migration best?",
  header: "Approach",
  domain: "arch",
  options: [
    { label: "Big bang", description: "Cut over in one release." },
    { label: "Incremental", description: "Move one module at a time behind a flag." },
    { label: "Strangler", description: "Route new traffic to the new path." },
  ],
}];

const MULTI = [
  { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
  { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
];

async function mountDesktopSession(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await mountView(page, {
    view: "sessions",
    // Dashboard view, where the card's Ask button shows (Messages view has none).
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
}

async function openQuestionCard(page: Page, questions: unknown): Promise<void> {
  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, questions);
  await page.locator(".prompt-card").waitFor();
  // The card settles through a transform transition; shoot and measure after it.
  await page.waitForTimeout(400);
}

test.describe("view-harness / desktop question card in the phone layout", () => {
  test("single question: Ask on the band, arrow is Submit, no footer button", async ({ page }) => {
    await mountDesktopSession(page);
    await openQuestionCard(page, SINGLE);

    const card = page.locator(".prompt-card");
    await expect(page.locator("#prompt-card-host")).toHaveClass(/prompt-card-host--composer/);
    await expect(card.locator('.prompt-card__header [data-act="ask"]')).toBeHidden();
    await expect(card.locator('[data-act="ask-inline"]')).toBeVisible();
    await expect(card.locator('.prompt-card__footer > [data-act="primary"]')).toBeHidden();
    const arrow = card.locator(".prompt-card__answer-bar .prompt-answer-send");
    await expect(arrow).toBeVisible();
    await expect(arrow).toHaveClass(/is-submit/);

    await card.screenshot({ path: `${SHOTS}/question-card-desktop-single.png` });
  });

  test("context box and ask band run edge to edge, flush under the header", async ({ page }) => {
    await mountDesktopSession(page);
    await openQuestionCard(page, [{
      question: "The relay drops frames under load. Which approach fits best?",
      header: "Approach",
      domain: "arch",
      options: [{ label: "A" }, { label: "B" }],
    }]);

    const card = page.locator(".prompt-card");
    const cardBox = (await card.boundingBox())!;
    const header = (await card.locator(".prompt-card__header").boundingBox())!;
    const ctx = (await card.locator(".prompt-zone--ctx").boundingBox())!;
    const ask = (await card.locator(".prompt-zone--ask").boundingBox())!;
    // 1px each side is the card's own border.
    for (const zone of [ctx, ask]) {
      expect(zone.x).toBeLessThanOrEqual(cardBox.x + 1.5);
      expect(zone.x + zone.width).toBeGreaterThanOrEqual(cardBox.x + cardBox.width - 1.5);
    }
    expect(ctx.y).toBeLessThanOrEqual(header.y + header.height + 1.5);

    await card.screenshot({ path: `${SHOTS}/question-card-desktop-context.png` });
  });

  for (const [name, body] of [
    ["inline-code span", "`Setup new claude account / Send dane how to use it and then a good deal more text after that`"],
    ["fenced code block", "```\nSetup new claude account / Send dane how to use it and then a good deal more text after that\n```"],
  ] as const) {
    test(`a long ${name} in the context wraps instead of overflowing the card`, async ({ page }) => {
      await mountDesktopSession(page);
      await page.setViewportSize({ width: 390, height: 800 });
      await openQuestionCard(page, [{
        question: `Keep note 3 (list, "Todo")\n\n${body}\n\nLeave, archive or delete?`,
        header: "Note",
        domain: "data",
        options: [{ label: "Leave in Keep" }, { label: "Archive" }],
      }]);

      const overflow = await page.locator(".prompt-card .prompt-zone--ctx").evaluate((zone) => {
        const text = zone.querySelector(".prompt-ctx__text")!;
        const zoneRight = zone.getBoundingClientRect().right;
        const code = text.querySelector("code")!.getBoundingClientRect();
        return { codeRight: code.right, zoneRight, scroll: text.scrollWidth - text.clientWidth };
      });
      expect(overflow.codeRight).toBeLessThanOrEqual(overflow.zoneRight);
      expect(overflow.scroll).toBeLessThanOrEqual(1);

      await page.locator(".prompt-card").screenshot({ path: `${SHOTS}/question-card-wrapped-${name.replace(/\W+/g, "-")}.png` });
    });
  }

  test("review step keeps its Submit button and has no arrow", async ({ page }) => {
    await mountDesktopSession(page);
    await openQuestionCard(page, MULTI);

    const card = page.locator(".prompt-card");
    // Question steps: the arrow is Next (not styled as Submit), footer button hidden.
    await expect(card.locator('.prompt-card__footer > [data-act="primary"]')).toBeHidden();
    await expect(card.locator(".prompt-answer-send")).not.toHaveClass(/is-submit/);

    await card.locator('.prompt-dot[data-dot="2"]').click();
    await page.waitForTimeout(300);
    const submit = card.locator('.prompt-card__footer > [data-act="primary"]');
    await expect(submit).toBeVisible();
    await expect(submit).toHaveText(/Submit/);
    await expect(submit).toBeEnabled();
    await expect(card.locator(".prompt-answer-send")).toHaveCount(0);
    const control = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-h")));
    expect(Math.round((await submit.boundingBox())!.height)).toBe(control);

    // The body has no top padding, so the review panel's own gap keeps its intro off the header.
    const headerBox = (await card.locator(".prompt-card__header").boundingBox())!;
    const introBox = (await card.locator(".prompt-summary__intro").boundingBox())!;
    expect(introBox.y - (headerBox.y + headerBox.height)).toBeGreaterThanOrEqual(8);

    await card.screenshot({ path: `${SHOTS}/question-card-desktop-review.png` });
  });

  test("--viewport fallback host keeps its footer button and has no arrow", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page);
    // No session pane is mounted, so the renderer itself falls back to the
    // viewport host; the session-routed entry point would refuse without a session.
    await page.evaluate(async (q) => {
      const mod = await import("/views/sessions/permission-modal/question-ui.ts");
      mod.renderQuestionUI({
        questions: q as never,
        titleIcon: "ph-chat-circle-dots",
        submitLabel: "Submit",
        submitIcon: "ph-paper-plane-right",
        cancelLabel: "Skip",
        onSubmit: () => {},
        onCancel: () => {},
      });
    }, SINGLE);
    await page.locator(".prompt-card").waitFor();

    const card = page.locator(".prompt-card");
    await expect(page.locator("#prompt-card-host")).toHaveClass(/prompt-card-host--viewport/);
    const primary = card.locator('.prompt-card__footer > [data-act="primary"]');
    await expect(primary).toBeVisible();
    await expect(primary).toHaveText(/Submit/);
    await expect(card.locator(".prompt-answer-send")).toHaveCount(0);
  });
});
