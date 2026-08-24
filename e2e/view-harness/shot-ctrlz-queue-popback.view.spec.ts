import { expect, test, type Page } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, mountView, sessionInstance } from "./harness";

// Todo 736: the Ctrl+Z queue pop-back flow (358a8074) had unit coverage but
// nothing driving the real composer + held-messages DOM together. Stages via
// real Enter presses, pops via real Ctrl+Z, then checks a typed edit breaks
// the chain.

const STAMP = "2026-08-24T10:00:00Z";
const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [sessionInstance({ busy: true, awaiting: null })],
  get_active_sessions: [sessionInstance({ busy: true, awaiting: null })],
  load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
  get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
  add_held_message: { id: 1, updated_at: STAMP },
  update_held_message: { updated_at: STAMP },
  remove_held_message: { updated_at: STAMP },
  clear_held_messages: { updated_at: STAMP },
  set_composer_draft: { updated_at: STAMP },
  clear_composer_draft: { updated_at: STAMP },
};

/** Boot the busy chat and stage three held messages via real Enter presses,
 *  the same path a user typing while a turn is in flight takes. */
async function mountAndStageThree(page: Page): Promise<ReturnType<Page["locator"]>> {
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  const textarea = page.locator("#session-pane .session-composer .composer-textarea");
  await expect(textarea).toBeVisible();

  for (const text of ["First message", "Second message", "Third message"]) {
    await textarea.fill(text);
    await textarea.press("Enter");
  }
  await expect(page.locator("#session-pane .held-count")).toHaveText("3");
  await expect(textarea).toHaveValue("");
  return textarea;
}

test.describe("view-harness / Ctrl+Z queue pop-back", () => {
  test("walks the held queue LIFO, then a typed edit breaks the chain", async ({ page }) => {
    const textarea = await mountAndStageThree(page);

    // 1) Empty draft: first press pops the MOST RECENT staged item.
    await textarea.press("Control+z");
    await expect(textarea).toHaveValue("Third message");
    await expect(page.locator("#session-pane .held-count")).toHaveText("2");

    // 2) Mid-chain (draft now non-empty): second press pops the next-older
    //    item and prepends it, joined by a blank line.
    await textarea.press("Control+z");
    await expect(textarea).toHaveValue("Second message\n\nThird message");
    await expect(page.locator("#session-pane .held-count")).toHaveText("1");

    // 3) Typing breaks the chain - a further Ctrl+Z must not pop "First
    //    message" off the queue. Held count and dropdown contents stay put.
    await textarea.press("x");
    await expect(textarea).toHaveValue("Second message\n\nThird messagex");
    await textarea.press("Control+z");
    await expect(page.locator("#session-pane .held-count")).toHaveText("1");

    // The one remaining item is still "First message", untouched.
    await page.locator("#session-pane .held-chip").click();
    await expect(page.locator("#session-pane .held-row")).toHaveText("First message");
  });
});
