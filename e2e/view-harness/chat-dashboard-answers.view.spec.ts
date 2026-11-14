// Reviewed 2026-11-14 (Result card, finished tray): the Result is its own card under Plan, finished subs sit in a tray under it and the From subs card is gone; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-13 (From subs): the dashboard gained a From subs zone in the left column that draws sub reports which are not answers; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-13 (stale blockers): Waiting on you drops an own blocker once the chat sends a later report, answer, plan or same-target blocker, each Waiting card gains a written time and a hover x (Clear all once two can go) kept per chat in localStorage, and the card copy button is hidden there; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (shown badly): chat-dashboard.ts adds a contextmenu listener for the card menu's "Shown badly" item (chat-shown-badly.view.spec.ts covers it); nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (honest sub states): subs gained queued/paused/usage-limit/stopped kinds with a dim ring and glyph, an avatar hover card, the Plan foot's sub counts and a glowing main-chat ring; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (per-chat previews): the Preview card lists only the previews this chat pushed (newest big, the rest as a thumbnail strip) and folds the family's others behind "N more by other chats"; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (answers pending row): answers-model.ts adds a row per question handed to a sub (spawn_chat, read-only, report_back) until its answer fills it, and the dashboard passes the sub list only once it holds this chat; this spec has no hand-off, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (dashboard Drafts card): a new left-column zone draws write_draft drafts, the draft card takes an optional version and Edit form, and the dashboard reads the drafts store; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (plan-card-lifecycle): the Answers card now also draws with no answer (No answers yet, New question) and the Plan card always draws beside it; every chat in this spec has answers, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (warm Ask threads): answers-card.ts streams a reply and calls answers_thread_prewarm on open (an unmocked call only logs a warning); this spec passes unchanged.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (question-card-ask): the Ask panel and its strip/dial entries are gone, a question card's Ask (shown only in Dashboard view) minimizes the card and opens a thread in the Answers card, and the thread classes moved from ask-* to ax-*; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (answers-question-rewrite): the card asks the daemon for a short question only for an answer with no `question` and a message past 90 chars; this spec's answers carry their own, so it passes.
// Reviewed 2026-11-10 (dash lane 3): chat-dashboard.ts and dashboard-zones.ts gained the Subchats card's host and wiring; this spec's chats have no subs and the Answers card is untouched, so it passes.
// Reviewed 2026-11-10 (dash-extras): the dashboard gained the Links and files, Preview window and Changes zones and reads list_previews/chat_quick_view (both caught when unmocked); the Answers card is untouched, and this spec passes.
// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-card.css, src/views/sessions/chat-dashboard/answers-api.ts, src/shared/chat/dashboard/answers-model.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The dashboard's Answers card in the real app shell (docs/chat-dashboard-design.md,
// "Answers card"): it rests at 210px with its buttons on the bottom edge, Got it
// walks back through the unread answers with only the text moving, and the last
// one fades to All caught up. A chat whose answers the daemon already has marked
// read opens straight on All caught up. The newest answer always takes the card,
// and the chat's judgement of Joe's next message (`read_answers`) marks answers read.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";

let n = 0;
// A fixed afternoon (seconds): the question line leads with the answer's time.
const AT = 1_762_783_260;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`, timestamp = 0) => [
  { type: "tool_use", tool_name, input, id, timestamp, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const user = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0 });

const HISTORY = [
  user("does it read the Shortcut tracker or start from scratch?"),
  ...tool(SEND, { kind: "answer", verdict: "It copies Shortcut's shape", tone: "good", question: "Does Trello reuse the Shortcut tracker, or start from scratch?", text: "Trello fits the same small tracker interface with one board id.\nNo new settings page; the board id sits next to the Shortcut and Linear ids." }, "a1", AT),
  user("does it link tr- numbers like the shortcut ones?"),
  ...tool(SEND, { kind: "answer", verdict: "Yes, once the board confirms", tone: "good", question: "Do tr- numbers link the way Shortcut's sc- numbers do?", text: "tr-12 links only after Trello confirms card 12 is on this project's board.\nSame rule as Shortcut, so a stray tr- in prose stays plain text." }, "a2", AT + 300),
  user("does the token need write access?"),
  ...tool(SEND, { kind: "answer", verdict: "No, read-only is enough", tone: "good", question: "Does the Trello token need write access?", text: "The token only reads boards and cards to confirm ids, so read access is enough.\nThe key modal says so next to the field." }, "a3", AT + 1140),
  ...tool("mcp__cc_conductor__report_turn_status", { status: "done" }),
];

const EMPTY_STORE = { read: {}, threads: {}, questions: [] };

async function openChat(page: Page, store: unknown): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      answers_state: store,
      ask_list_threads: [],
      answers_mark: store,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const card = (page: Page) => page.locator("#session-pane .cdash-answers");
const pane = (page: Page) => page.locator("#session-pane");

test.describe("Answers card", () => {
  test("walks from three unread answers to All caught up", async ({ page }) => {
    await openChat(page, EMPTY_STORE);
    const c = card(page);
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("No, read-only is enough");
    await expect(c.locator(".ax-head .mc-label")).toContainText("Answers");
    // History's badge counts the other unread answers.
    await expect(c.locator("[data-ax='history'] b")).toHaveText("2");

    // Rests at 210px with the check and thread buttons bottom left, Read more bottom right.
    const shell = c.locator(".ax-shell");
    const box = (await shell.boundingBox())!;
    expect(Math.abs(box.height - 210)).toBeLessThan(4);
    const got = (await c.locator("[data-ax='gotit']").boundingBox())!;
    const rm = (await c.locator(".ax-readmore").boundingBox())!;
    expect(box.y + box.height - (got.y + got.height)).toBeLessThan(20);
    expect(got.x - box.x).toBeLessThan(30);
    expect(box.x + box.width - (rm.x + rm.width)).toBeLessThan(30);
    await capture(pane(page), "answers-unread");

    // Read more opens the full text under the time; Joe's question is not on the face, it heads the thread.
    await c.locator(".ax-readmore").click();
    await expect(c.locator(".ax-face")).toHaveClass(/open/);
    await expect(c.locator(".ax-by time")).not.toHaveText("");
    await expect(c.locator(".ax-face")).not.toContainText("Does the Trello token need write access?");
    await page.waitForTimeout(400);
    await capture(pane(page), "answers-read-more");

    const header = (await c.locator(".ax-head").boundingBox())!;
    await c.locator("[data-ax='gotit']").click();
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Yes, once the board confirms");
    // Rise moves only the text: the header stays exactly where it was.
    const header2 = (await c.locator(".ax-head").boundingBox())!;
    expect(header2.y).toBe(header.y);
    await expect(c.locator(".ax-face")).toHaveClass(/open/);
    await expect(c.locator("[data-ax='history'] b")).toHaveText("1");

    await c.locator("[data-ax='gotit']").click();
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("It copies Shortcut's shape");
    await expect(c.locator("[data-ax='history'] b")).toHaveCount(0);
    await c.locator("[data-ax='gotit']").click();

    await expect(c.locator(".ax-cc-t")).toHaveText("All caught up");
    await expect(c.locator(".ax-cc [data-ax='history']")).toBeVisible();
    await expect(c.locator(".ax-cc [data-ax='new-q']")).toBeVisible();
    await page.waitForTimeout(400);
    await capture(pane(page), "answers-caught-up");
  });

  test("a newer answer takes the card over an older unread one, and a judged read turns the check into Next", async ({ page }) => {
    await openChat(page, EMPTY_STORE);
    const c = card(page);
    const pick = async (title: string) => {
      await c.locator("[data-ax='history']").click();
      await page.locator(".cp-row", { hasText: title }).click();
    };
    // Joe goes back to the oldest answer, still unread.
    await pick("It copies Shortcut's shape");
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("It copies Shortcut's shape");
    await expect(c.locator("[data-ax='gotit']")).toBeVisible();

    // His next message reacts to it; the chat says so on its first message, then answers.
    await fireEvent(page, CHANNEL, [
      user("ok so it copies shortcut, and the board id?"),
      ...tool(SEND, { kind: "ack", text: "Checking the board id", read_answers: ["It copies Shortcut's shape"] }, "j1", AT + 2000),
      ...tool(SEND, { kind: "answer", verdict: "One board per project", question: "How many Trello boards can a project use?", text: "The board id is one field per project." }, "a4", AT + 2100),
    ]);
    // The new answer takes the card although Joe was on an unread one.
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("One board per project");
    // Judged read: only a2 and a3 are the other unread ones now.
    await expect(c.locator("[data-ax='history'] b")).toHaveText("2");

    // The judged answer shows as read; with others unread its check is the way to the next one.
    await pick("It copies Shortcut's shape");
    await expect(c.locator("[data-ax='gotit']")).toHaveCount(0);
    const next = c.locator(".ax-next[data-ax='close']");
    await expect(next).toContainText("3 more");
    await page.waitForTimeout(400);
    await capture(pane(page), "answers-judged-read-next");
    await next.click();
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("One board per project");
  });

  test("a chat whose answers are already read opens on All caught up, with History grouped", async ({ page }) => {
    await openChat(page, { read: { a1: 1, a2: 1, a3: 1 }, threads: {}, questions: [] });
    const c = card(page);
    await expect(c.locator(".ax-cc-t")).toHaveText("All caught up");
    await c.locator(".ax-cc [data-ax='history']").click();
    const rows = page.locator(".cp-row .cp-title");
    // Titled by the verdict, the answer Joe reads; the question is searched, and heads the thread.
    await expect(rows).toHaveText(["No, read-only is enough", "Yes, once the board confirms", "It copies Shortcut's shape"]);
    await expect(page.locator(".cp-input")).toHaveAttribute("placeholder", "Search 3 answers and their threads");
    await capture(page.locator(".cp"), "answers-history");
    await page.locator(".cp-row").nth(1).click();
    await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Yes, once the board confirms");
    // The thread opens in place on the question and its answer, sliding in from the right.
    await c.locator("[data-ax='reply']").click();
    await expect(c.locator(".ax-thead-k")).toHaveText("Thread");
    await expect(c.locator(".ax-tbody .ax-q0")).toContainText("Do tr- numbers link the way Shortcut's sc- numbers do?");
    await expect(c.locator(".ax-tbody .ax-t-bub")).toContainText("Yes, once the board confirms");
    await expect(c.locator(".ax-t-input")).toBeFocused();
    await page.waitForTimeout(400);
    await capture(pane(page), "answers-thread");
    await c.locator("[data-ax='close-thread']").click();
    // A read answer's check is grey and puts it away again.
    await expect(c.locator("[data-ax='close']")).toBeVisible();
    await c.locator("[data-ax='close']").click();
    await expect(c.locator(".ax-cc-t")).toHaveText("All caught up");
  });
});
