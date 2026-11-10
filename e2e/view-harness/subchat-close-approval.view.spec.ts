// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// Reviewed 2026-11-09: the sidebar right-click menu is now a flat four-item list; its Close item is still the .smore-danger button this spec clicks, and it passes.
// Reviewed 2026-11-05: sidebar-ctx-menu.ts passes `isSub` to the chat menu; the close approval card is unchanged and this spec passes.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/close-chat.ts, src/views/sessions/sidebar-ctx-menu.ts, src/views/sessions/permission-modal/index.ts
import { test, expect, type Page } from "@playwright/test";
import { fireEvent, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// Subchats step 8: closing a main chat that still has a sub running. The daemon
// holds the close and asks Joe on a card (wait for them, close them too, keep it
// open), so the menu's Close must leave the row where it is and must not report
// the chat closed until that card is answered. A main chat whose subs have all
// finished closes as any chat does. Driven through the real sessions view, the
// real context menu and the real question card, at desktop and phone width.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };

const MAIN = sessionInstance({ session_id: "main", name: "CV redesign", pid: 101 });
const RUNNING = sessionInstance({ session_id: "sub-run", name: "Header", pid: 102, subchat_of: "main", busy: true });
const FINISHED = sessionInstance({ session_id: "sub-done", name: "Footer", pid: 103, subchat_of: "main", subchat_finished: true });

const closeCard = {
  id: "card-close",
  session_id: "main",
  display_session_id: "main",
  sub_id: null,
  card_kind: "subchat_close",
  daemon_card: true,
  seq: 1,
  questions: [
    {
      question: "Closing this chat has 1 sub still running: **Header**.\n\nWhat should happen to it first?",
      header: "Close with subs running",
      multiSelect: false,
      options: [
        { label: "Wait for them", description: "Close this chat when the last one finishes" },
        { label: "Close them too", description: "End them now, then close" },
        { label: "Keep it open", description: "Do not close" },
      ],
    },
  ],
};

async function mount(page: Page, size: { width: number; height: number }, sessions: unknown[], clearResult: boolean): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: sessions,
      get_active_sessions: sessions,
      list_pending_prompts: [],
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      confirm_question_rendered: null,
      respond_question: true,
      clear_session: clearResult,
      cancel_turn: null,
      list_auto_accept: [],
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.evaluate(() => {
    (window as unknown as { __closed: string[] }).__closed = [];
    document.addEventListener("cc:session-closed", (e) => (window as unknown as { __closed: string[] }).__closed.push((e as CustomEvent).detail.sessionId));
  });
}

async function clickCloseInMenu(page: Page): Promise<void> {
  await page.locator('#sessions-list li[data-session-id="main"]').click({ button: "right" });
  await page.locator(".session-ctx-menu .smore-item.smore-danger").click();
}

const closedEvents = (page: Page) => page.evaluate(() => (window as unknown as { __closed: string[] }).__closed);

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / closing a main chat with subs (${label})`, () => {
    test("the menu's Close keeps the row and raises no closed event while the daemon holds it, and the card offers the three answers", async ({ page }) => {
      await mount(page, size, [MAIN, RUNNING, FINISHED], true);
      await clickCloseInMenu(page);
      await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "clear_session").length).toBe(1);

      // The daemon raises the card in this chat's window.
      await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
      await page.locator('#sessions-list li[data-session-id="main"]').click();
      await page.locator("#session-pane .session-composer").waitFor();
      await waitForPaneSettled(page);
      await fireEvent(page, "question-requested", [closeCard]);
      const card = page.locator(".prompt-card");
      await expect(card).toHaveCount(1);
      await expect(card).toContainText("Header");
      await expect(card.locator(".prompt-opt")).toHaveCount(3);
      await expect(card.locator('.prompt-opt input[data-label="Wait for them"]')).toHaveCount(1);
      await expect(card.locator('.prompt-opt input[data-label="Close them too"]')).toHaveCount(1);
      await expect(card.locator('.prompt-opt input[data-label="Keep it open"]')).toHaveCount(1);

      // Nothing closed it: the row is still there, no exit ran, no closed event fired.
      await page.waitForTimeout(500);
      await expect(page.locator('#sessions-list li[data-session-id="main"]')).toHaveCount(1);
      expect(await closedEvents(page)).toEqual([]);
    });

    test("a main chat whose subs have all finished closes as any chat does", async ({ page }) => {
      await mount(page, size, [MAIN, FINISHED], false);
      await clickCloseInMenu(page);
      await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "clear_session").length).toBe(1);
      await expect.poll(() => closedEvents(page)).toEqual(["main"]);
    });
  });
}
