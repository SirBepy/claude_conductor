// asserts: src/views/sessions/permission-modal/question-ui-render.ts, src/views/sessions/question-ask.ts, src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/permission-modal-shell.css
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// A question card's Ask (docs/chat-dashboard-design.md, "Asking about a question
// card"): the card drops to its bar and the dashboard's Answers card opens a
// thread on the question and its options, even in a chat with no answers yet.
// The reply lands in Answers, and Back opens the card again with a half-typed
// answer intact. With no dashboard behind the card (Messages view, the phone)
// there is no Ask button at all.

const SESSION = sessionInstance();

const QUESTION = [{
  question: "Which cache layer should hold the session index?",
  options: [
    { label: "Memory", description: "Fast, lost on restart." },
    { label: "Disk", description: "Survives restart." },
  ],
}];

const NOW = 1_762_783_260_000;
const THREAD = {
  id: "t1", created_at: NOW, updated_at: NOW, sidecar_session_id: "x",
  messages: [
    { role: "user", text: "which one survives a reinstall?", ts: NOW - 4000 },
    { role: "assistant", text: "QUESTION: Which cache layer survives a reinstall?\nVERDICT: Disk does\n\nMemory is gone on every restart; the disk index stays.", ts: NOW },
  ],
};

async function openCard(page: Page, chatView: "dashboard" | "messages"): Promise<void> {
  await mountView(page, {
    view: "sessions",
    chatView,
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      answers_state: { read: {}, threads: {}, questions: [] },
      ask_list_threads: [],
      answers_mark: { read: {}, threads: {}, questions: [] },
      answers_thread_send: { thread: THREAD, state: { read: {}, threads: {}, questions: [{ thread_id: "t1", asked_at: NOW - 4000 }] } },
    },
  });
  await page.locator(`#sessions-list li[data-session-id='${SESSION.session_id}']`).click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
  await page.evaluate(async ([q, sid]) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: sid as string, questions: q as never });
  }, [QUESTION, SESSION.session_id] as const);
  await page.locator(".prompt-card").waitFor();
}

const answers = (page: Page) => page.locator("#session-pane .cdash-answers");

test("Ask minimizes the card, opens a thread on the question in Answers, and Back brings the card back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openCard(page, "dashboard");
  await page.mouse.move(700, 450);
  await capture(page.locator("#session-pane"), "question-ask-card");

  // Half-typed answer that must survive the detour.
  const other = page.locator(".prompt-card__answer-bar .prompt-q__other-input");
  await other.fill("partial thought");
  // No answers yet: the Answers card stands empty (it always draws), with no thread.
  await expect(answers(page).locator(".ax-empty")).toBeVisible();

  await page.locator('.prompt-card [data-act="ask-inline"]').click();
  await expect(page.locator(".prompt-collapsed")).toBeVisible();
  await expect(page.locator(".prompt-card")).toHaveCount(0);
  const a = answers(page);
  await expect(a.locator(".ax-thead-k")).toHaveText("About a question");
  await expect(a.locator(".ax-thead-v")).toHaveText("Which cache layer should hold the session index?");
  await expect(a.locator(".ax-about")).toContainText("Memory: Fast, lost on restart.");
  await expect(a.locator(".ax-about")).toContainText("Disk: Survives restart.");
  await expect(a.locator(".ax-t-input")).toBeFocused();
  await page.waitForTimeout(400);
  await capture(page.locator("#session-pane"), "question-ask-thread");

  await a.locator(".ax-t-input").fill("which one survives a reinstall?");
  await a.locator(".ax-t-send").click();
  await expect(a.locator(".ax-thead-v")).toHaveText("Which cache layer survives a reinstall?");
  await expect(a.locator(".ax-about")).toBeVisible();
  const sent = await page.evaluate(() => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__ccInvokeCalls.filter((c) => c.cmd === "answers_thread_send"));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.args.key).toBeNull();
  expect(String(sent[0]!.args.aboutQuestion)).toContain("Which cache layer should hold the session index?");
  expect(String(sent[0]!.args.aboutQuestion)).toContain("**Disk**: Survives restart.");
  await page.waitForTimeout(300);
  await capture(page.locator("#session-pane"), "question-ask-reply");

  await a.locator("[data-ax='close-thread']").click();
  await expect(page.locator(".prompt-card")).toBeVisible();
  await expect(other).toHaveValue("partial thought");
  await expect(a.locator(".ax-face .mc-verdict")).toHaveText("Disk does");
  await page.waitForTimeout(400);
  await capture(page.locator("#session-pane"), "question-ask-back");
});

// The phone always draws Messages view (chat-view-pref.ts dashboardEnabled), so
// this is the phone's case too.
test("in Messages view the card has no Ask, since no Answers card can take it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openCard(page, "messages");
  await expect(page.locator('.prompt-card [data-act="ask-inline"]')).toBeHidden();
  await expect(page.locator('.prompt-card [data-act="ask"]')).toBeHidden();
});
