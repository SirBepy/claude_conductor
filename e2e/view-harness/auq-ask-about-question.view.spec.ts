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

  await page.locator('.prompt-card [data-act="ask"]').click();

  const input = page.locator("[data-ask-input]");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(/Which cache layer should hold the session index\?/);
  await expect(input).toHaveValue(/Memory \(Fast, lost on restart\.\); Disk \(Survives restart\.\)/);

  // Prefilled, not sent: nothing was asked yet.
  await expect(page.locator(".ask-q")).toHaveCount(0);

  await expect(page.locator(".prompt-card")).toBeVisible();
  await expect(other).toHaveValue("partial thought");
  await expect(page.locator('.prompt-card__footer [data-act="primary"]')).toBeEnabled();
});
