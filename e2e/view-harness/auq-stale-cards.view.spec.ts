// Reviewed 2026-11-12 (shown badly): chat-dashboard.ts adds a contextmenu listener for the card menu's "Shown badly" item (chat-shown-badly.view.spec.ts covers it); nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (Compact now): the chat menu gained a Compact now item; Dismiss open questions is unchanged and this spec passes.
// Reviewed 2026-11-12: the card header's asker chip became an avatar for a sub and a "Main chat" chip for a main chat (C5, asker-face.ts); this spec's contract is unchanged and it passes.
// Reviewed 2026-11-12 (per-chat previews): the Preview card lists only the previews this chat pushed (newest big, the rest as a thumbnail strip) and folds the family's others behind "N more by other chats"; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11: the Undo hold on sends and card answers is gone (a send or answer goes out at once); nothing this spec asserts depends on it, and it passes.
// Reviewed 2026-11-11 (plan-close): dashboard-model.ts's jobs gained an `ended` flag the Plan card uses to draw never-ticked steps as left open; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (answers pending row): answers-model.ts adds a row per question handed to a sub (spawn_chat, read-only, report_back) until its answer fills it, and the dashboard passes the sub list only once it holds this chat; this spec has no hand-off, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (dashboard Drafts card): a new left-column zone draws write_draft drafts, the draft card takes an optional version and Edit form, and the dashboard reads the drafts store; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (question-card-ask): the dashboard gained the question card's Ask thread (answersThreadOpen draws the Answers zone for it) and listens for cc-question-ask; nothing this spec asserts changed, and it passes.
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/permission-modal/question-state.ts, src/views/sessions/permission-modal/question-submit.ts, src/views/sessions/permission-modal/resurface.ts, src/views/sessions/permission-modal/dismiss-open-questions.ts, src/views/sessions/chat-menu-items.ts, src/shared/chat/chat-question-card.ts, src/shared/chat/question-texts.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, runPaletteCommand, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Question cards that stayed "awaiting answer" after Joe answered or skipped
// them (2026-11-10). The daemon's prompt id was a random uuid while the
// transcript keys a card by Claude's tool_use id, so every Skip mark named an id
// no card carries and a reload brought the card back; a card the daemon lost
// (an app update before cards were saved) took no mark at all. And the question
// open in the answer card by the message box was drawn a second time in the
// dashboard's Waiting on you.

const SESSION = sessionInstance();
const SID = SESSION.session_id;
const ASK = "mcp__cc_conductor__ask_user_question";
const RECEIPT = '{"acknowledged":true,"note":"The card is shown."}';
const OLD_DAEMON_ID = "799df8a4-9d30-4294-bbb1-36b05a4b6949";

const PUSH_Q = "Push the 2 commits without the full pipeline?";
const DELETE_Q = "Delete the wedding_dj folder now?";

const ask = (id: string, question: string, ts: number) => [
  { type: "tool_use", tool_name: ASK, id, timestamp: ts, parent_tool_use_id: null,
    input: { questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] } },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: RECEIPT }, is_error: false, timestamp: ts },
];
const user = (text: string, ts: number) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: ts });

const HISTORY = [
  user("clean up the old projects", 1_000),
  ...ask("toolu_delete", DELETE_Q, 2_000),
  ...ask("toolu_push", PUSH_Q, 3_000),
];

const prompt = (id: string, question: string) => ({
  id, event: "question-requested", durable: true,
  payload: { id, session_id: SID, seq: 4, questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] },
});

async function openChat(page: Page, over: { pending?: unknown[]; marks?: unknown[]; history?: unknown[] } = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  const history = over.history ?? HISTORY;
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      list_pending_prompts: over.pending ?? [],
      get_skipped_question_marks: over.marks ?? [],
      get_session_drafts: {},
      respond_question: false,
      load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SID}"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
}

const waiting = (page: Page) => page.locator("#session-pane .cdash-waiting");

async function skipCalls(page: Page): Promise<Array<{ id?: string; sessionId?: string }>> {
  return page.evaluate(() =>
    ((window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args?: { id?: string; sessionId?: string; skipped?: boolean } }> }).__ccInvokeCalls)
      .filter((c) => c.cmd === "respond_question" && c.args?.skipped === true)
      .map((c) => c.args ?? {}));
}

test.describe("view-harness / stale and doubled question cards", () => {
  test("the question open by the message box is not drawn again in Waiting on you", async ({ page }) => {
    await openChat(page, { pending: [prompt("toolu_push", PUSH_Q)] });
    await expect(page.locator(".prompt-card")).toContainText(PUSH_Q);

    await expect(waiting(page).locator(".question-card")).toHaveCount(1);
    await expect(waiting(page)).toContainText(DELETE_Q);
    await expect(waiting(page)).not.toContainText(PUSH_Q);
    await capture(page.locator("#session-pane"), "auq-open-card-not-doubled");

    // Minimized to its bar the question is not shown there, so the dashboard
    // lists it again.
    await page.locator('.prompt-card [data-act="minimize"]').click();
    await expect(waiting(page).locator(".question-card")).toHaveCount(2);
    await expect(waiting(page)).toContainText(PUSH_Q);
  });

  test("a prompt from before the ids matched is found by what it asks", async ({ page }) => {
    await openChat(page, { pending: [prompt(OLD_DAEMON_ID, PUSH_Q)] });
    await expect(page.locator(".prompt-card")).toContainText(PUSH_Q);
    await expect(waiting(page).locator(".question-card")).toHaveCount(1);
    await expect(waiting(page)).not.toContainText(PUSH_Q);
  });

  test("a question asked twice keeps its older copy in Waiting on you", async ({ page }) => {
    const twice = [user("clean up", 1_000), ...ask("toolu_first", PUSH_Q, 2_000), ...ask("toolu_again", PUSH_Q, 3_000)];
    await openChat(page, { history: twice, pending: [prompt("toolu_again", PUSH_Q)] });
    await expect(page.locator(".prompt-card")).toContainText(PUSH_Q);
    // Only the card the popover stands for leaves, never every card asking the same.
    await expect(waiting(page).locator(".question-card")).toHaveCount(1);
    await expect(waiting(page).locator(".question-card")).toHaveAttribute("data-question-id", "toolu_first");

    // Clicking that older copy opens it, so Skip settles it and not the newer one.
    await waiting(page).locator(".question-card").click();
    await page.locator('.prompt-card [data-act="minimize"]').click();
    await page.locator('.prompt-collapsed [data-act="cancel"]').click();
    await expect.poll(async () => (await skipCalls(page)).map((c) => c.id)).toEqual(["toolu_first"]);
  });

  test("Skip on a card the daemon no longer holds clears it and names the card", async ({ page }) => {
    await openChat(page);
    await expect(waiting(page).locator(".question-card")).toHaveCount(2);

    await waiting(page).locator(".question-card", { hasText: DELETE_Q }).click();
    const card = page.locator(".prompt-card");
    await expect(card).toContainText(DELETE_Q);
    await card.locator('[data-act="minimize"]').click();
    await page.locator('.prompt-collapsed [data-act="cancel"]').click();

    await expect.poll(() => skipCalls(page)).toEqual([expect.objectContaining({ id: "toolu_delete", sessionId: SID })]);
    await expect(waiting(page).locator(".question-card")).toHaveCount(1);
    await expect(waiting(page)).not.toContainText(DELETE_Q);
  });

  test("clicking a stale card opens that card, not the daemon's other question", async ({ page }) => {
    await openChat(page, { pending: [prompt(OLD_DAEMON_ID, PUSH_Q)] });
    await expect(page.locator(".prompt-card")).toContainText(PUSH_Q);
    await waiting(page).locator(".question-card", { hasText: DELETE_Q }).click();
    await expect(page.locator(".prompt-card")).toContainText(DELETE_Q);
  });

  test("Skip on a prompt from before the ids matched also marks the card under its own id", async ({ page }) => {
    await openChat(page, { pending: [prompt(OLD_DAEMON_ID, PUSH_Q)] });
    await expect(page.locator(".prompt-card")).toContainText(PUSH_Q);
    await page.locator('.prompt-card [data-act="minimize"]').click();
    await page.locator('.prompt-collapsed [data-act="cancel"]').click();

    // The daemon's own id settles its prompt; the card's id leaves the mark a
    // reload can match, since no card carries the daemon's id.
    await expect.poll(async () => (await skipCalls(page)).map((c) => c.id)).toEqual([OLD_DAEMON_ID, "toolu_push"]);
    await expect(waiting(page).locator(".question-card")).toHaveCount(1);
    await expect(waiting(page)).not.toContainText(PUSH_Q);
  });

  test("an old Skip mark naming a random daemon id hides no card", async ({ page }) => {
    // Matching it by time could hide a question that is still open; such a
    // card is cleared from the chat menu instead.
    await openChat(page, { marks: [{ timestamp: 3_500, question_id: OLD_DAEMON_ID }] });
    await expect(waiting(page).locator(".question-card")).toHaveCount(2);
  });

  test("a Skip mark naming the card hides that card, not the newest one", async ({ page }) => {
    await openChat(page, { marks: [{ timestamp: 3_500, question_id: "toolu_delete" }] });
    await expect(waiting(page).locator(".question-card")).toHaveCount(1);
    await expect(waiting(page)).toContainText(PUSH_Q);
  });

  test("Dismiss open questions in the chat menu clears every waiting card", async ({ page }) => {
    await openChat(page, { pending: [prompt(OLD_DAEMON_ID, PUSH_Q)] });
    await expect(page.locator(".prompt-card")).toContainText(PUSH_Q);

    await runPaletteCommand(page, "Dismiss 2 open questions");

    await expect(page.locator(".prompt-card")).toHaveCount(0);
    await expect(waiting(page)).toHaveCount(0);
    const calls = await skipCalls(page);
    // The held prompt under the daemon's own id (which drops it from the
    // daemon) and under its card id, the lost one under its card id: each card
    // id leaves the durable mark.
    expect(calls.map((c) => c.id).sort()).toEqual([OLD_DAEMON_ID, "toolu_delete", "toolu_push"].sort());
    await capture(page.locator("#session-pane"), "auq-dismissed-all");
  });
});
