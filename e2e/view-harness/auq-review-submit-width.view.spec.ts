// asserts: src/views/sessions/permission-modal-shell.css
import { test, expect } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// The review step's Submit is a normal-width button on desktop, not a
// stretched call-to-action bar (the phone stretches it full width instead).

const SESSION = sessionInstance();

const MULTI = [
  { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
  { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
];

test("desktop review step's Submit keeps normal button width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);

  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, MULTI);
  const card = page.locator(".prompt-card");
  await card.waitFor();
  await card.locator('.prompt-dot[data-dot="2"]').click();

  const submit = card.locator('.prompt-card__footer > [data-act="primary"]');
  await expect(submit).toBeVisible();
  await expect(submit).toHaveClass(/prompt-submit-cta/);
  // A stretched CTA measured 280px here; a normal button is well under that.
  const width = await submit.evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeLessThan(160);
});
