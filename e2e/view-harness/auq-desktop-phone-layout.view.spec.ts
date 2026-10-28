// asserts: src/views/sessions/permission-modal-shell.css, src/views/sessions/permission-modal/question-ui-answer-bar.ts
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
