// Reviewed 2026-11-23 (merged Plan card): a main chat's Plan card now lists its subs as feature lines and drops the Subchats and Attachments cards, and SubCardItem gained a steps list; nothing this spec asserts changed, and it passes in the run of every dependent spec.
// Reviewed 2026-11-23 (merged Plan card, tracker marks): dashboard-zones.ts draws a ticket link row with its tracker's outline mark; nothing this spec asserts changed, and it passes (run of every dependent spec).
// Reviewed 2026-11-21 (Run card and opened sub view tabs): chat-dashboard.ts, dashboard-zones.ts, dashboard-extras.css and subs-card.ts changed for the Run card's after names and the sub view's Plan and Attachments tabs; nothing this spec asserts changed, and it passes (run of every dependent spec).
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/done-card.ts, src/views/sessions/chat-dashboard/done-card.css, src/shared/chat/subchat-cards.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, delayInvokes, fireEvent, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A main chat's finished subs wait in the Done card under the Plan card, one row per
// TASK (Joe, 2026-11-17: "one row per task, I do not need to see that several chats
// worked on it"): the task, a warning when a chat of it ran out of context, how many
// chats it took and when it was done. A click opens the todo id with an Open todo
// button and the chats with their finish time and context; a chat's click opens the same
// finish card Messages view draws. Dismiss and Clear all leave at once and close in the
// background. The list scrolls inside a bounded height. A finish that answers Joe's
// question is in Answers too.

const CWD = "C:/Projects/conductor";
const MIN = 60_000;
const NOW = Date.now();
const MAIN = sessionInstance({ session_id: "main", name: "App polish batch", pid: 101, cwd: CWD });
const sub = (id: string, name: string, pid: number, startedAt = "2026-11-17T08:00:00Z") =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, subchat_of: "main", subchat_finished: true, awaiting: "done", busy: false, started_at: startedAt });
// Two chats carry the id pc-0031: the build, then a review. The other two stand alone.
const SUBS = [
  sub("sub-a", "pc-0031-dup-subchat-toggle", 102, "2026-11-17T08:00:00Z"),
  sub("sub-c", "pc-0031-review", 105, "2026-11-17T09:00:00Z"),
  sub("sub-b", "hide-chips-on-input", 103),
  sub("sub-q", "why-slow", 104),
];

const finish = (id: string, subId: string, name: string, ts: number, verdict: string, text: string, over: Record<string, unknown> = {}) => ({
  id, ts, parent_id: "main", kind: "finish", sub_id: subId, sub_name: name, round: 1, model: "sonnet", effort: "high",
  verdict, tone: "good", text, points: [], done: ["Root cause found"], not_done: [], waiting_on: [], your_move: [],
  facts: null, sum: null, set_key: null, ...over,
});

const SEND = "mcp__cc_conductor__send_message";
const T_FIRST = NOW - 30 * MIN;
const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "fix these three things" }], timestamp: T_FIRST, remote_echo: false, is_meta: false, author_session_id: null },
  { type: "tool_use", tool_name: SEND, input: { kind: "report", verdict: "3 jobs handed to subs", text: "All three run as subs." }, id: "m1", timestamp: T_FIRST + 1000, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: "m1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];

const CARDS = [
  // Older than the loaded page: the dashboard hides the transcript, so no older page ever loads.
  finish("f-old", "sub-b", "hide-chips-on-input", T_FIRST - 60 * MIN, "Chips hide while typing", "The draft screen's chip row hides with text in the box."),
  finish("f-a", "sub-a", "pc-0031-dup-subchat-toggle", NOW - 10 * MIN, "pc-0031: Not two toggles", "Use subchats and Plain chat instead are separate cards; a CSS tie painted the hidden one."),
  finish("f-c", "sub-c", "pc-0031-review", NOW - 3 * MIN, "pc-0031: review fixes in, still a go", "Review found no blockers."),
  finish("f-q", "sub-q", "why-slow", NOW - 5 * MIN, "The history read is not it", "Chat open spends its time in the bulk load.", { question: "Why is chat open slow?" }),
];

const CTX_34 = { model: "claude-sonnet-4-6", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 };
const CTX_91 = { ...CTX_34, occupancy: 910_000, remaining: 90_000, pct_used: 91, pct_left: 9 };

interface OpenOpts {
  invoke?: Record<string, unknown>;
  subs?: ReturnType<typeof sub>[];
  cards?: unknown[];
  /** Delays clear_session by this many ms (the close runs after the row has left). */
  slowClose?: number;
}

async function openMain(page: Page, chatView: "dashboard" | "messages", o: OpenOpts = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  const subs = o.subs ?? SUBS;
  await mountView(page, {
    view: "sessions",
    chatView,
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [MAIN, ...subs],
      get_active_sessions: [MAIN, ...subs],
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 10, newest_seq: 12, has_more: true },
      list_subchat_cards: o.cards ?? CARDS,
      list_session_images: { images: [] },
      get_sub_brief: { brief: null },
      list_previews: [],
      context_status: CTX_34,
      clear_session: false,
      ...o.invoke,
    },
  });
  if (o.slowClose) await delayInvokes(page, ["clear_session"], o.slowClose);
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
}

const done = (page: Page) => page.locator("#session-pane .cdash .cdash-done");
const task = (page: Page, title: string) => done(page).locator(".dn-task").filter({ has: page.locator(".dn-title", { hasText: new RegExp(`^${title}$`) }) });
const closes = async (page: Page) => (await invokeCalls(page)).filter((c) => c.cmd === "clear_session");

test.describe("chat dashboard / done card", () => {
  test("lists one row per task, newest first, with how long ago it finished, and none of the per-chat lines", async ({ page }) => {
    await openMain(page, "dashboard");
    await expect(done(page)).toBeVisible();
    // The pc-0031 task holds two chats and is the newest, then why-slow, then the older one.
    expect(await done(page).locator(".dn-title").allTextContents()).toEqual(["Dup subchat toggle", "Why slow", "Hide chips on input"]);
    // The compact row has no chat count (it sits in the opened row) and says how long ago, in words.
    await expect(done(page).locator(".dn-n")).toHaveCount(0);
    await expect(task(page, "Why slow").locator(".dn-at")).toHaveText("5 min ago");
    await expect(task(page, "Dup subchat toggle").locator(".dn-at")).toHaveText("3 min ago");
    // Nothing of the chats shows until a task is opened, and no warning at 34% context.
    await expect(done(page).locator(".dn-sub")).toHaveCount(0);
    await expect(done(page).locator(".dn-warn")).toHaveCount(0);
    // A finish carrying Joe's question is the answer: Answers has it too.
    await expect(page.locator("#session-pane .cdash .cdash-answers")).toContainText("The history read is not it");
    await expect(page.locator("#session-pane .cdash .cdash-reports")).toHaveCount(0);
    await capture(page.locator("#session-pane"), "done-card-rest");
  });

  test("sits in the right column under the Plan card, while the Result is on the left", async ({ page }) => {
    await openMain(page, "dashboard");
    await expect(page.locator("#session-pane .cdash-left .cdash-resultcard")).toContainText("3 jobs handed to subs");
    expect((await done(page).boundingBox())!.y).toBeGreaterThan((await page.locator("#session-pane .cdash-right .cdash-plan").boundingBox())!.y);
  });

  test("a click opens the todo id, an Open todo button and each chat with its finish time and context; a second click closes it", async ({ page }) => {
    await openMain(page, "dashboard");
    await page.evaluate(() => {
      (window as unknown as { __todoOpened: string[] }).__todoOpened = [];
      window.addEventListener("cc-backlog-open", (e) => (window as unknown as { __todoOpened: string[] }).__todoOpened.push((e as CustomEvent).detail.id));
    });
    const t = task(page, "Dup subchat toggle");
    await t.locator(".dn-main").click();
    await expect(t.locator(".dn-n")).toHaveText("2 chats");
    await expect(t.locator(".dn-todo-id")).toHaveText("pc-0031");
    await expect(t.locator(".dn-sub")).toHaveCount(2);
    // Newest chat first, each with its time and the context it ended at.
    await expect(t.locator(".dn-sub").first().locator(".dn-line")).toHaveText("pc-0031: review fixes in, still a go");
    await expect(t.locator(".dn-sub").first().locator(".dn-at")).not.toBeEmpty();
    await expect(t.locator(".dn-sub").first().locator(".sb-context")).toHaveText("34%");
    await capture(page.locator("#session-pane"), "done-card-open");
    await t.locator(".dn-todo-btn").click();
    expect(await page.evaluate(() => (window as unknown as { __todoOpened: string[] }).__todoOpened)).toEqual(["pc-0031"]);
    await t.locator(".dn-main").click();
    await expect(t.locator(".dn-detail")).toHaveCount(0);
  });

  test("a task with no todo id has no Open todo button", async ({ page }) => {
    await openMain(page, "dashboard");
    await task(page, "Why slow").locator(".dn-main").click();
    await expect(task(page, "Why slow").locator(".dn-sub")).toHaveCount(1);
    await expect(task(page, "Why slow").locator(".dn-todo")).toHaveCount(0);
  });

  test("a chat's click opens the finish card with its name and text, and a second click closes it", async ({ page }) => {
    await openMain(page, "dashboard");
    await task(page, "Dup subchat toggle").locator(".dn-main").click();
    const row = task(page, "Dup subchat toggle").locator('.dn-sub[data-sub="sub-a"]');
    await row.locator(".dn-sub-main").click();
    const card = done(page).locator('.dn-card .mc-root[data-sub-card="1"]');
    await expect(card.locator(".mc-full .mc-sub-name")).toHaveText("pc-0031-dup-subchat-toggle");
    await expect(card).toContainText("a CSS tie painted the hidden one");
    await row.locator(".dn-sub-main").click();
    await expect(card).toHaveCount(0);
  });

  test("a card that lands live updates its chat's line", async ({ page }) => {
    await openMain(page, "dashboard");
    await task(page, "Why slow").locator(".dn-main").click();
    const line = task(page, "Why slow").locator(".dn-line");
    await expect(line).toHaveText("The history read is not it");
    await fireEvent(page, "subchat-card", [{ session_id: "main", card: finish("f-live", "sub-q", "why-slow", Date.now() + 1000, "Second round", "More.") }]);
    await expect(line).toHaveText("Second round");
  });

  test("warns on a task when any chat of it ended at 80% context or more", async ({ page }) => {
    await openMain(page, "dashboard", { invoke: { context_status: CTX_91 } });
    await expect(task(page, "Why slow").locator(".dn-warn")).toBeVisible();
    await expect(task(page, "Dup subchat toggle").locator(".dn-warn")).toBeVisible();
    await capture(page.locator("#session-pane"), "done-card-warning");
  });

  test("the list scrolls inside a bounded height instead of growing with the tasks", async ({ page }) => {
    const many = Array.from({ length: 16 }, (_, i) => sub(`sub-x${i}`, `task-number-${i + 1}`, 200 + i));
    const cards = [...CARDS, ...many.map((s, i) => finish(`f-x${i}`, s.session_id, s.name ?? "", NOW - (20 + i) * MIN, `Done ${i + 1}`, "Text."))];
    await openMain(page, "dashboard", { subs: [...SUBS, ...many], cards });
    const list = done(page).locator(".dn-list");
    await expect(done(page).locator(".dn-task")).toHaveCount(19);
    const box = (await list.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(270);
    expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
    expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    await list.evaluate((el) => { el.scrollTop = 120; });
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // A redraw keeps Joe's place in the list.
    await fireEvent(page, "subchat-card", [{ session_id: "main", card: finish("f-live", "sub-q", "why-slow", Date.now() + 1000, "Second round", "More.") }]);
    await expect(task(page, "Why slow").locator(".dn-title")).not.toHaveCount(0);
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await capture(page.locator("#session-pane"), "done-card-scroll");
  });

  test("Dismiss leaves at once, before the close has answered, and closes every chat of the task without messaging it", async ({ page }) => {
    await openMain(page, "dashboard", { slowClose: 2500 });
    const t = task(page, "Dup subchat toggle");
    await t.hover();
    await t.locator(".dn-x").click();
    // The close takes 2.5 s; the row is gone well before it could have answered.
    await expect(t).toHaveCount(0, { timeout: 900 });
    await expect(done(page).locator(".dn-task")).toHaveCount(2);
    await expect.poll(async () => (await closes(page)).length).toBe(2);
    expect((await closes(page)).map((c) => (c.args as { sessionId: string }).sessionId).sort()).toEqual(["sub-a", "sub-c"]);
    expect((await invokeCalls(page)).filter((c) => c.cmd === "send_message")).toEqual([]);
  });

  test("Clear all removes every row at once and closes every finished chat", async ({ page }) => {
    await openMain(page, "dashboard", { slowClose: 2500 });
    await done(page).locator(".dn-clear").click();
    await expect(done(page)).toHaveCount(0, { timeout: 900 });
    await expect.poll(async () => (await closes(page)).length).toBe(4);
    expect((await closes(page)).map((c) => (c.args as { sessionId: string }).sessionId).sort()).toEqual(["sub-a", "sub-b", "sub-c", "sub-q"]);
  });

  test("a close the daemon holds puts the row back", async ({ page }) => {
    await openMain(page, "dashboard", { invoke: { clear_session: true } });
    const t = task(page, "Why slow");
    await t.hover();
    await t.locator(".dn-x").click();
    await expect.poll(async () => (await closes(page)).length).toBe(1);
    await expect(task(page, "Why slow")).toHaveCount(1);
  });

  test("Messages view draws the same finish cards in the transcript", async ({ page }) => {
    await openMain(page, "messages");
    const subCard = page.locator('#session-pane .session-messages .mc-root[data-sub-card="1"]');
    // The page has an older one unloaded, so only cards from its first row on are placed here.
    await expect(subCard.filter({ hasText: "Not two toggles" })).toHaveCount(1);
    await expect(subCard.filter({ hasText: "The history read is not it" })).toHaveCount(1);
    await expect(subCard.filter({ hasText: "Chips hide while typing" })).toHaveCount(0);
  });
});
