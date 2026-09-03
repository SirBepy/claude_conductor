import { test, expect } from "@playwright/test";
import { mountView, capture, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// todo 755: an ANSWERED question card in the transcript used to be inert -
// sessions.ts's pane click listener only handled the still-pending case.
// Commit a3db4c9b added a read-only replay (reopenAnsweredPrompt); this
// verifies it against a real mounted session pane, not just unit tests.

const SESSION = sessionInstance();

declare global {
  interface Window {
    __ccQuestionId?: string;
  }
}

/** Injects a resolved `.msg.question-card` element into the mounted session's
 *  transcript exactly as chat-dom-renderer.ts's buildMessageEl would, and
 *  registers it on state.renderer.messages so reopenAnsweredPrompt (invoked
 *  by sessions.ts's real pane click listener) can find it by id. */
async function injectAnsweredCard(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const { state } = await import("/views/sessions/state.ts");
    const { buildMessageEl } = await import("/shared/chat/chat-dom-renderer.ts");

    const message = {
      kind: "question",
      id: "q1",
      text: "User answered the question(s):\nQ: Which theme?\nA: Dark",
      input: { questions: [{ question: "Which theme?", options: [{ label: "Dark" }, { label: "Light" }] }] },
    } as never;

    const renderer = state.renderer as unknown as { messages: unknown[] };
    renderer.messages.push(message);
    const el = buildMessageEl(message);
    document.querySelector(".session-messages")!.appendChild(el);
    window.__ccQuestionId = "q1";
  });
}

test.describe("view-harness / clicking an answered question card in the transcript", () => {
  test("reopens a dismissable read-only shell with no submit control", async ({ page }) => {
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
    await injectAnsweredCard(page);

    const transcriptCard = page.locator(".msg.question-card[data-question-id='q1']");
    await expect(transcriptCard).toBeVisible();
    // Resolved (not pending) - the fork this todo's fix depends on.
    await expect(transcriptCard.locator(".tool-qa-a--pending")).toHaveCount(0);

    await transcriptCard.click();

    const replay = page.locator(".prompt-card");
    await expect(replay).toBeVisible();
    await expect(replay).toContainText("Which theme?");
    await expect(replay).toContainText("Dark");
    // Read-only: renderQuestionCardHtml carries no button of its own, and the
    // shell's only control is the Close button, never a submit/primary one.
    await expect(replay.locator("button")).toHaveCount(1);
    await expect(replay.locator('[data-act="close"]')).toHaveCount(1);
    await expect(replay.locator('[data-act="primary"]')).toHaveCount(0);

    await capture(page, "auq-answered-card-reopen");
  });

  test("clicking the same answered card twice never leaves two replay cards open", async ({ page }) => {
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
    await injectAnsweredCard(page);

    const transcriptCard = page.locator(".msg.question-card[data-question-id='q1']");
    await transcriptCard.click();
    await expect(page.locator(".prompt-card")).toHaveCount(1);

    await transcriptCard.click();
    await expect(page.locator(".prompt-card")).toHaveCount(1);
    await expect(page.locator("#prompt-card-host")).toHaveCount(1);
  });
});
