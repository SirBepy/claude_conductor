// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// asserts: src/shared/chat/dashboard/answers-model.ts, src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-card.css, src/views/sessions/chat-dashboard/subs-source.ts, src/shared/chat/dashboard/subs-model.ts, src/shared/chat/dashboard/dashboard-model.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A question the main chat hands to a sub (SUBCHATS_MAIN_PROMPT rule 11) shows in
// the Answers card the moment the spawn_chat call is in the transcript: the
// rewritten question with "Checking... (<sub>)" under it. Its answer fills that
// same row when it lands, never a second one. A sub that ended, failed or was
// never started says so, and the rows rebuild from the transcript on a reload.

const SESSION = sessionInstance();
const MAIN = SESSION.session_id;
const CHANNEL = `chat:${MAIN}`;
const SEND = "mcp__cc_conductor__send_message";
const SPAWN = "mcp__cc_conductor__spawn_chat";
const SUBCHAT = "mcp__cc_conductor__subchat";
const AT = 1_762_783_260;

let n = 0;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`, timestamp = 0, result = "{\"ok\":true}", isError = false) => [
  { type: "tool_use", tool_name, input, id, timestamp, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: result }, is_error: isError, timestamp },
];
const user = (text: string, timestamp = 0) => ({ type: "user_message", content: [{ type: "text", text }], timestamp });
/** Rule 11's hand-off, with the result the daemon gives a started sub. */
const handoff = (id: string, name: string, task: string, subId: string, at: number, over: Record<string, unknown> = {}) =>
  tool(SPAWN, { name, task, goal: "Find out.", done_when: "A one-line answer.", writes: false, review: false, report_back: true, ...over }, id, at, JSON.stringify({ ok: true, session_id: subId }));
const ack = (at: number) => tool(SEND, { kind: "ack", text: "Handed to a sub" }, `ack${++n}`, at);
const done = () => tool("mcp__cc_conductor__report_turn_status", { status: "done" });
const sub = (id: string, name: string, over: Record<string, unknown> = {}) =>
  sessionInstance({ session_id: id, name, pid: 200 + id.length, subchat_of: MAIN, busy: true, ...over });

const EMPTY_STORE = { read: {}, threads: {}, questions: [], rewrites: {} };

async function openChat(page: Page, history: unknown[], subs: unknown[] = [], cards: unknown[] = []): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION, ...subs],
      get_active_sessions: [SESSION],
      load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
      list_subchat_cards: cards,
      answers_state: EMPTY_STORE,
      ask_list_threads: [],
      answers_mark: EMPTY_STORE,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${MAIN}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const card = (page: Page) => page.locator("#session-pane .cdash-answers");
const pane = (page: Page) => page.locator("#session-pane");
const historyCount = (page: Page) => card(page).locator("[data-ax='history']");

test.describe("Answers card: handed-off questions", () => {
  test("shows the question at once as a pending row, and its answer fills that same row", async ({ page }) => {
    await openChat(page, [
      user("is master good to go for a release right now or is something red?", AT),
      ...handoff("s1", "release-q", "Is master ready for /release now?", "sub-1", AT + 5),
      ...ack(AT + 6),
      ...done(),
    ], [sub("sub-1", "release-q")]);
    const c = card(page);
    const face = c.locator(".ax-face.ax-pending");
    await expect(face).toBeVisible();
    await expect(face.locator(".ax-pend-q")).toHaveText("Is master ready for /release now?");
    await expect(face.locator(".ax-pend-q")).toHaveAttribute("title", /You wrote: is master good to go/);
    await expect(face.locator(".ax-pend-line")).toHaveText("Checking... (release-q)");
    await expect(face.locator(".ax-spin")).toHaveCount(1);
    // Nothing to mark read while the sub is still checking.
    await expect(c.locator("[data-ax='gotit']")).toHaveCount(0);
    await expect(historyCount(page)).toHaveAttribute("title", /^All 1 answer/);
    await capture(pane(page), "answers-pending-checking");

    // The sub finishes; the main chat reads it and sends the answer (rule 11).
    await fireEvent(page, CHANNEL, [
      ...tool(SUBCHAT, { action: "status", sub: "release-q" }, "st1", AT + 300),
      ...tool(SEND, { kind: "answer", verdict: "Yes, ready to release", tone: "good", question: "Is master ready for /release now?", text: "Every fast check is green on master and nothing is waiting to merge." }, "a1", AT + 301),
    ]);
    await expect(c.locator(".ax-face.ax-pending")).toHaveCount(0);
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Yes, ready to release");
    await expect(c.locator(".ax-face")).toHaveAttribute("data-ans", "a1");
    // The same row: still one item, now an answer to mark read.
    await expect(historyCount(page)).toHaveAttribute("title", /^All 1 answer/);
    await expect(c.locator("[data-ax='gotit']")).toBeVisible();
    await c.locator(".ax-readmore").click();
    await expect(c.locator(".ax-face")).toHaveClass(/open/);
    await page.waitForTimeout(400);
    await capture(pane(page), "answers-pending-answered");
  });

  test("several at once: the newest shows, Next walks to the other, and each answer fills its own row", async ({ page }) => {
    await openChat(page, [
      user("why is the phone slow, and which port does the harness use?", AT),
      ...handoff("s1", "phone-slow-q", "Why does the phone take long to load?", "sub-1", AT + 5),
      ...handoff("s2", "harness-port-q", "Which port does the view harness serve on?", "sub-2", AT + 6),
      ...ack(AT + 7),
      ...done(),
    ], [sub("sub-1", "phone-slow-q"), sub("sub-2", "harness-port-q", { progress: { plan: null, state_since: null, waiting_for: "harness-lock" } })]);
    const c = card(page);
    await expect(c.locator(".ax-pend-q")).toHaveText("Which port does the view harness serve on?");
    await expect(c.locator(".ax-pend-line")).toHaveText("Queued (harness-port-q)");
    await expect(c.locator(".ax-pend-note")).toHaveText("harness-lock");
    await expect(historyCount(page)).toHaveAttribute("title", /^All 2 answers/);
    await c.locator("[data-ax='next']").click();
    await expect(c.locator(".ax-pend-q")).toHaveText("Why does the phone take long to load?");
    await expect(c.locator(".ax-pend-line")).toHaveText("Checking... (phone-slow-q)");

    // Its answer words the question differently, so the status call it made names the row.
    await fireEvent(page, CHANNEL, [
      ...tool(SUBCHAT, { action: "status", sub: "phone-slow-q" }, "st1", AT + 300),
      ...tool(SEND, { kind: "answer", verdict: "The usage history is huge", question: "What makes the phone slow to open?", text: "It downloads 14.6MB of usage history on open." }, "a1", AT + 301),
    ]);
    await expect(c.locator(".ax-face")).toHaveAttribute("data-ans", "a1");
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("The usage history is huge");
    await expect(historyCount(page)).toHaveAttribute("title", /^All 2 answers/);
    // Mark all read leaves the question still in flight on the card, not All caught up.
    await historyCount(page).click();
    await page.locator(".cp-row", { hasText: "Mark all 1 as read" }).click();
    await expect(c.locator(".ax-pend-q")).toHaveText("Which port does the view harness serve on?");

    // The second answer repeats its question, and fills the row on the card.
    await fireEvent(page, CHANNEL, [
      ...tool(SEND, { kind: "answer", verdict: "4420", question: "Which port does the view harness serve on?", text: "Set VIEW_HARNESS_PORT for a second run." }, "a2", AT + 400),
    ]);
    await expect(c.locator(".ax-face")).toHaveAttribute("data-ans", "a2");
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("4420");
    await expect(historyCount(page)).toHaveAttribute("title", /^All 2 answers/);
  });

  test("a sub that ended, failed or never started says so, and Got it puts each away", async ({ page }) => {
    await openChat(page, [
      user("five questions", AT),
      // Cut off: the turn ended before the daemon answered the spawn.
      { type: "tool_use", tool_name: SPAWN, input: { name: "cut-q", task: "Does the relay keep FCM tokens?", writes: false, report_back: true }, id: "s0", timestamp: AT + 4, parent_tool_use_id: null },
      ...handoff("s1", "ended-q", "Is the iroh tunnel still advertised?", "sub-1", AT + 5),
      ...handoff("s2", "failed-q", "What does the Console return for next credit?", "sub-2", AT + 6),
      ...tool(SPAWN, { name: "refused-q", task: "Which tier runs the gate?", writes: false, report_back: true }, "s3", AT + 7, JSON.stringify({ ok: false, error: "goal is missing" })),
      // A later hand-off of another question does not hide the refusal: only a retry of the same one does.
      ...handoff("s4", "other-q", "Which model runs the Ask sidecar?", "sub-4", AT + 8),
      ...ack(AT + 9),
      ...done(),
    ], [
      sub("sub-1", "ended-q", { busy: false, ended_at: "2026-11-11T10:00:00Z", end_reason: "manual" }),
      sub("sub-2", "failed-q", { busy: false, subchat_finished: true }),
      sub("sub-4", "other-q"),
    ], [
      { id: "c1", ts: (AT + 200) * 1000, parent_id: MAIN, kind: "finish", sub_id: "sub-2", sub_name: "failed-q", verdict: "Console route not found", tone: "bad", text: "No known route returns the date." },
    ]);
    const c = card(page);
    const face = c.locator(".ax-face.ax-pending");
    await expect(face).toHaveAttribute("data-pending", "refused");
    await expect(face.locator(".ax-pend-line")).toHaveText("Not handed off: the sub did not start");
    await expect(face.locator(".ax-pend-note")).toHaveText("goal is missing");
    await c.locator("[data-ax='gotit']").click();
    await expect(face).toHaveAttribute("data-pending", "failed");
    await expect(face.locator(".ax-pend-line")).toHaveText("failed-q could not answer");
    await expect(face.locator(".ax-pend-note")).toHaveText("Console route not found: No known route returns the date.");
    await page.waitForTimeout(400);
    await capture(pane(page), "answers-pending-failed");
    await c.locator("[data-ax='gotit']").click();
    await expect(face).toHaveAttribute("data-pending", "ended");
    await expect(face.locator(".ax-pend-line")).toHaveText("ended-q ended without an answer");
    await c.locator("[data-ax='gotit']").click();
    await expect(face).toHaveAttribute("data-pending", "refused");
    await expect(face.locator(".ax-pend-q")).toHaveText("Does the relay keep FCM tokens?");
    await expect(face.locator(".ax-pend-note")).toHaveText("The turn ended before the daemon answered the hand-off.");
    await c.locator("[data-ax='gotit']").click();
    // What is left is still being checked, so the card stays on it instead of All caught up.
    await expect(face).toHaveAttribute("data-pending", "checking");
    await expect(face.locator(".ax-pend-q")).toHaveText("Which model runs the Ask sidecar?");
    await expect(c.locator("[data-ax='gotit']")).toHaveCount(0);
  });

  test("after a reload an answered hand-off is one row, a pending one is its row, and other spawns and answers stay apart", async ({ page }) => {
    await openChat(page, [
      user("is it on?", AT),
      ...handoff("s1", "on-q", "Is subchats mode on by default?", "sub-1", AT + 5),
      ...ack(AT + 6),
      ...done(),
      // A job that writes is never a question, even when it reports back.
      user("fix the footer", AT + 100),
      ...tool(SPAWN, { name: "footer", task: "Fix the footer.", writes: true, files: ["src/"], report_back: true }, "s2", AT + 101, JSON.stringify({ ok: true, session_id: "sub-2" })),
      // Nor is a read-only research job the main chat runs for its own next step.
      ...handoff("s2b", "footer-scan", "Find where the footer's padding is set.", "sub-2b", AT + 102),
      ...tool(SUBCHAT, { action: "status", sub: "on-q" }, "st1", AT + 300),
      ...tool(SEND, { kind: "answer", verdict: "Yes, on by default", question: "Is subchats mode on by default?", text: "New chats start with it on." }, "a1", AT + 301),
      user("and who owns the writer slot?", AT + 400),
      ...handoff("s3", "slot-q", "Who holds the writer slot right now?", "sub-3", AT + 405),
      ...ack(AT + 406),
      ...done(),
      // slot-q has finished, but this answer names its own question and read no sub: it is not slot-q's.
      user("what does Got it do?", AT + 500),
      ...tool(SEND, { kind: "answer", verdict: "Marks it read", question: "What does Got it do on an answer?", text: "It marks the answer read and shows the next unread one." }, "a2", AT + 501),
      ...done(),
    ], [sub("sub-1", "on-q", { busy: false, subchat_finished: true }), sub("sub-2", "footer"), sub("sub-3", "slot-q", { busy: false, subchat_finished: true })], [
      { id: "c3", ts: (AT + 450) * 1000, parent_id: MAIN, kind: "finish", sub_id: "sub-3", sub_name: "slot-q", verdict: "Nobody holds it", tone: "good", text: "The slot is free." },
    ]);
    const c = card(page);
    await expect(c.locator(".ax-face")).toHaveAttribute("data-ans", "a2");
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Marks it read");
    await expect(historyCount(page)).toHaveAttribute("title", /^All 3 answers/);
    await c.locator("[data-ax='gotit']").click();
    await expect(c.locator(".ax-pend-q")).toHaveText("Who holds the writer slot right now?");
    await expect(c.locator(".ax-pend-line")).toHaveText("slot-q finished, the answer is on its way");
    await c.locator("[data-ax='gotit']").click();
    await expect(c.locator(".ax-face")).toHaveAttribute("data-ans", "a1");
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Yes, on by default");
  });
  test("an answer worded differently still fills the row of the sub that just finished, and an instruction is no question", async ({ page }) => {
    await openChat(page, [
      user("does the relay keep anything about me?", AT),
      ...handoff("s1", "relay-q", "Does the relay store anything about Joe?", "sub-1", AT + 5),
      // A read-only job the main chat runs for itself: an instruction, not Joe's question.
      ...handoff("s2", "log-scan", "Can you look at the relay log and list its errors", "sub-2", AT + 6),
      ...ack(AT + 7),
      ...done(),
      // The wake turn: no status call, and the question reworded.
      ...tool(SEND, { kind: "answer", verdict: "Only a token and a handle", question: "What does the relay keep about Joe?", text: "An FCM token and a random handle, nothing else." }, "a1", AT + 400),
      ...done(),
    ], [sub("sub-1", "relay-q", { busy: false, subchat_finished: true }), sub("sub-2", "log-scan")], [
      { id: "c1", ts: (AT + 300) * 1000, parent_id: MAIN, kind: "finish", sub_id: "sub-1", sub_name: "relay-q", verdict: "Token and handle only", tone: "good", text: "FCM token plus a random handle." },
    ]);
    const c = card(page);
    await expect(c.locator(".ax-face")).toHaveAttribute("data-ans", "a1");
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Only a token and a handle");
    await expect(historyCount(page)).toHaveAttribute("title", /^All 1 answer/);
    await c.locator("[data-ax='gotit']").click();
    await expect(c.locator(".ax-cc-t")).toHaveText("All caught up");
  });
  test("a sub's finish carrying the question is the answer: it fills the row under the sub's name, and a follow-up gets its own", async ({ page }) => {
    const finish = (round: number, ts: number, verdict: string, text: string, question: string) => ({
      id: `finish-sub-1-${round}`, ts, parent_id: MAIN, kind: "finish", sub_id: "sub-1", sub_name: "phone-ime", round,
      model: "opus", effort: "high", verdict, tone: "good", text, question, points: [], done: [], not_done: [], waiting_on: [], your_move: [],
    });
    const ms = AT * 1000;
    await openChat(page, [
      user("why does gboard voice and swipe break in the phone composer?", AT),
      ...tool(SPAWN, { name: "phone-ime", task: "Why do Gboard voice and swipe fail?", question: "Why do Gboard voice and swipe fail in the phone composer?", goal: "Find out.", done_when: "A one-line answer.", writes: false, review: false }, "s1", AT + 5, JSON.stringify({ ok: true, session_id: "sub-1" })),
      ...ack(AT + 6),
      ...done(),
      user("is it the same on desktop?", AT + 200),
      ...tool(SUBCHAT, { action: "send", sub: "phone-ime", question: "Does the same focus bug hit the desktop composer?" }, "f1", AT + 201, JSON.stringify({ ok: true, passed_to: ["phone-ime"], sub_ids: ["sub-1"] })),
      ...ack(AT + 202),
      ...done(),
    ], [sub("sub-1", "phone-ime")], [
      finish(1, ms + 100_000, "The composer grabs focus on open", "Opening a chat focuses the composer from code, so Gboard connects as a plain field: no voice, no swipe.", "Why do Gboard voice and swipe fail in the phone composer?"),
    ]);
    const c = card(page);
    // The sub's card is the answer, under the sub's name, with no question on its face.
    const face = c.locator(".ax-face:not(.ax-pending)");
    await expect(face.locator(".mc-verdict")).toHaveText("The composer grabs focus on open");
    await expect(face.locator(".ax-by-name")).toHaveText("phone-ime");
    await expect(face.locator(".ax-by .sx-face")).toHaveText("PH");
    await expect(face).not.toContainText("Why do Gboard voice and swipe fail");
    const av = (await face.locator(".ax-by-av").boundingBox())!;
    expect(av.width).toBeLessThan(30);
    // The follow-up waits on a row of its own.
    await expect(historyCount(page)).toHaveAttribute("title", /^All 2 answers/);
    await page.waitForTimeout(400);
    await capture(pane(page), "answers-sub-finish-answer");
    await c.locator("[data-ax='gotit']").click();
    await expect(c.locator(".ax-face.ax-pending .ax-pend-line")).toHaveText("Checking... (phone-ime)");
    await expect(c.locator(".ax-pend-q")).toHaveText("Does the same focus bug hit the desktop composer?");
  });
});
