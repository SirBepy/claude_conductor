// asserts: src/views/sessions/permission-modal-shell.css
// Reviewed 2026-10-28: the phone page's ask band now runs edge to edge (track viewport widened over the body padding, panels re-inset) - phone-media only, no change to this spec's contract.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// The review step's Submit is a normal-width button on desktop, not a
// stretched call-to-action bar; the phone stretches it full width and 48px tall.

const SESSION = sessionInstance();

const MULTI = [
  { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
  { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
];

async function openReview(page: Page): Promise<Locator> {
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
  return submit;
}

test("desktop review step's Submit keeps normal button width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const submit = await openReview(page);
  // A stretched CTA measured 280px here; a normal button is well under that.
  const width = await submit.evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeLessThan(160);
});

test("phone review step's Submit is a full-width, 48px-tall CTA", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const submit = await openReview(page);
  const box = await submit.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  // The footer's generic 32px button rule once out-ranked the CTA's 48px.
  expect(box.height).toBeGreaterThanOrEqual(48);
  expect(box.width).toBeGreaterThan(360);
});
