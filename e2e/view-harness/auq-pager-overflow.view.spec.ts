// asserts: src/views/sessions/permission-modal-track.css, src/views/sessions/permission-modal/question-ui-render.ts, src/views/sessions/permission-modal/question-ui-templates.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// With many questions the pager's dots used to push the header's right-hand
// buttons off the card. The dots row now shrinks and scrolls sideways, and
// keeps the current dot in view.

const SESSION = sessionInstance();
const COUNT = 60;

const MANY = Array.from({ length: COUNT }, (_, i) => ({
  question: `Question ${i + 1}?`,
  header: `Q${i + 1}`,
  options: [{ label: "A" }, { label: "B" }],
}));

async function mountSession(page: Page): Promise<void> {
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
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
}

test.describe("view-harness / question pager with many questions", () => {
  test("dots scroll instead of pushing the header buttons off the card", async ({ page }) => {
    await mountSession(page);
    await page.evaluate(async (q) => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
    }, MANY);
    const card = page.locator(".prompt-card");
    await card.waitFor();
    await page.waitForTimeout(400);

    const dots = card.locator(".prompt-dots");
    const overflow = await dots.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(overflow.scroll).toBeGreaterThan(overflow.client);

    const cardBox = (await card.boundingBox())!;
    const next = (await card.locator('.prompt-pager [data-nav="1"]').boundingBox())!;
    expect(next.x + next.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);

    // A mid-row dot has room to scroll either way, so it lands centred; an
    // end dot would clamp and hide a wrong offset.
    await dots.locator('.prompt-dot[data-dot="30"]').evaluate((el) => (el as HTMLElement).click());
    await page.waitForTimeout(300);
    const offCentre = await dots.evaluate((row) => {
      const cur = row.querySelector<HTMLElement>(".prompt-dot.is-current")!;
      const r = row.getBoundingClientRect();
      const c = cur.getBoundingClientRect();
      return Math.abs((c.left + c.width / 2) - (r.left + r.width / 2));
    });
    expect(offCentre).toBeLessThanOrEqual(2);

    await capture(card, "question-pager-overflow");
  });
});
