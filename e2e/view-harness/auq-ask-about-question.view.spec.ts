// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// Reviewed 2026-10-25: the phone question page moved Skip into the header (data-act="skip") and hides the footer's Skip/Next row, its answer arrow acting as Next/Submit - desktop-only header buttons this spec drives are unchanged and it passes.
// Reviewed 2026-10-25 (project dashboard moved into new-chat drafts and a page opened from the chat header's project name; the Projects tab, Projects page and project page are gone): this spec drives none of those surfaces and passed after the change, so its contract is unaffected.
// Reviewed 2026-10-22: the phone question card became a fullscreen page (header back arrow + "Question" label and an answer-box send arrow, all hidden on desktop; back collapses the card to its bar instead of falling through) - this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/permission-modal/question-ui-render.ts, src/views/sessions/ask-panel.ts, src/views/sessions/sessions.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// The quiet "Ask about this question" control on an open question card: Ask
// opens with the question and its options prefilled, and the card stays
// pending and answerable.

const SESSION = sessionInstance();

const QUESTION = [{
  question: "Which cache layer should hold the session index?",
  options: [
    { label: "Memory", description: "Fast, lost on restart." },
    { label: "Disk", description: "Survives restart." },
  ],
}];

async function openCard(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      ask_list_threads: [],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, QUESTION);
  await page.locator(".prompt-card").waitFor();
}

test("Ask about this question opens Ask prefilled while the card stays pending", async ({ page }) => {
  await openCard(page);

  // Half-typed answer that must survive the detour.
  const other = page.locator(".prompt-card__answer-bar .prompt-q__other-input");
  await other.fill("partial thought");

  await page.locator('.prompt-card [data-act="ask-inline"]').click();

  const input = page.locator("[data-ask-input]");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(/Which cache layer should hold the session index\?/);
  await expect(input).toHaveValue(/Memory \(Fast, lost on restart\.\); Disk \(Survives restart\.\)/);

  // Prefilled, not sent: nothing was asked yet.
  await expect(page.locator(".ask-q")).toHaveCount(0);

  await expect(page.locator(".prompt-card")).toBeVisible();
  await expect(other).toHaveValue("partial thought");
  await expect(page.locator(".prompt-card__footer .prompt-answer-send")).toBeEnabled();
  // Desktop mirrors the phone: Ask sits on the question band, not in the header, and the arrow is the only way forward.
  await expect(page.locator('.prompt-card__header [data-act="ask"]')).toBeHidden();
  await expect(page.locator('.prompt-card__footer [data-act="primary"]')).toBeHidden();
});

test("on a phone, the Ask window covers the fullscreen question card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCard(page);
  // The phone page hides the header Ask; its Ask sits on the question's own band.
  await page.locator('.prompt-card [data-act="ask-inline"]').click();

  const input = page.locator("[data-ask-input]");
  await expect(input).toBeVisible();
  // Visible is not enough: the card must not be what a tap at the input lands on.
  const hit = await input.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  expect(hit).toBe(true);
  await expect(page.locator(".fab-dial-fab")).toBeHidden();
});
// Reviewed 2026-10-23: question card passes its session id to the option-preview image reader; the preview-open slug lookup is scoped to the selected chat; the contract asserted here is unchanged.
// Reviewed 2026-10-25: the Ask panel box became the shared composer field (a textarea, seeded via seed()); this spec's question-to-Ask hand-off contract is unchanged and it passes.
