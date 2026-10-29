// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/permission-modal/question-ui.ts, src/views/sessions/permission-modal/question-ui-render.ts
// Reviewed 2026-10-25: the phone question page moved Skip into the header and its answer arrow became Next/Submit (live without typed text) - the answer bar's rebuild across the breakpoint is unchanged and this spec passes.
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// The answer bar's markup (phone page composer vs desktop field) is chosen
// when it is built, while the CSS that lays it out follows the live 768px
// query. Crossing the breakpoint with a question open must rebuild the bar,
// keeping the typed text.

const PHONE = { width: 393, height: 852 };
const DESKTOP = { width: 1200, height: 852 };
const SESSION = sessionInstance();

async function mountPhoneSession(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
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
}

test("the answer bar follows a live 768px crossing and keeps the typed text", async ({ page }) => {
  await mountPhoneSession(page);
  await page.evaluate(async () => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({
      id: "q-1",
      session_id: "s1",
      questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] as never,
    });
  });
  const bar = page.locator(".prompt-card__answer-bar");
  await expect(bar.locator(".pv-composer")).toHaveCount(1);
  await bar.locator("textarea").fill("half-typed answer");

  await page.setViewportSize(DESKTOP);
  await expect(bar.locator(".pv-composer")).toHaveCount(0);
  await expect(bar.locator(".composer-field")).toHaveCount(1);
  await expect(bar.locator("textarea")).toHaveValue("half-typed answer");

  await page.setViewportSize(PHONE);
  await expect(bar.locator(".pv-composer")).toHaveCount(1);
  await expect(bar.locator("textarea")).toHaveValue("half-typed answer");
});
// Reviewed 2026-10-23: question card now passes its session id to the option-preview image reader; the contract asserted here is unchanged.
