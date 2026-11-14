// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/finished-tray.ts, src/views/sessions/chat-dashboard/finished-tray.css, src/shared/chat/subchat-cards.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A main chat's finished subs wait in a tray under the Plan card (Joe, 2026-11-14:
// "when a subchat is fully done and prolly not needed anymore, it shows me in
// result that chat"): the avatar with its name on hover, one line on what it did,
// the context it ended with, and a Dismiss that closes it. A click opens the same
// finish card Messages view draws. A finish that answers Joe's question is in
// Answers too. The earlier "From subs" card is gone (2026-11-13: "i dont see
// subchats answers in the main chat window" is what it answered; the tray does now).

const CWD = "C:/Projects/conductor";
const MIN = 60_000;
const NOW = Date.now();
const MAIN = sessionInstance({ session_id: "main", name: "App polish batch", pid: 101, cwd: CWD });
const sub = (id: string, name: string, pid: number) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, subchat_of: "main", subchat_finished: true, awaiting: "done", busy: false });
const SUBS = [sub("sub-a", "dup-subchat-toggle", 102), sub("sub-b", "hide-chips-on-input", 103), sub("sub-q", "why-slow", 104)];

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
  finish("f-a", "sub-a", "dup-subchat-toggle", NOW - 10 * MIN, "Not two toggles", "Use subchats and Plain chat instead are separate cards; a CSS tie painted the hidden one."),
  finish("f-q", "sub-q", "why-slow", NOW - 5 * MIN, "The history read is not it", "Chat open spends its time in the bulk load.", { question: "Why is chat open slow?" }),
];

async function openMain(page: Page, chatView: "dashboard" | "messages"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, {
    view: "sessions",
    chatView,
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [MAIN, ...SUBS],
      get_active_sessions: [MAIN, ...SUBS],
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 10, newest_seq: 12, has_more: true },
      list_subchat_cards: CARDS,
      list_session_images: { images: [] },
      get_sub_brief: { brief: null },
      list_previews: [],
      context_status: { model: "claude-sonnet-4-6", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      clear_session: false,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
}

const tray = (page: Page) => page.locator("#session-pane .cdash .cdash-finished");
const row = (page: Page, id: string) => tray(page).locator(`.ft-row[data-sub="${id}"]`);

test.describe("chat dashboard / finished tray", () => {
  test("lists each finished sub newest first with its verdict as the one line and the context it ended with", async ({ page }) => {
    await openMain(page, "dashboard");
    await expect(tray(page)).toBeVisible();
    expect(await tray(page).locator(".ft-row").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sub))).toEqual(["sub-q", "sub-a", "sub-b"]);
    await expect(row(page, "sub-a").locator(".ft-line")).toHaveText("Not two toggles");
    // The sub whose card is older than every loaded transcript row still has its line.
    await expect(row(page, "sub-b").locator(".ft-line")).toHaveText("Chips hide while typing");
    await expect(row(page, "sub-a").locator(".sb-context")).toHaveText("34%");
    // A finish carrying Joe's question is the answer: Answers has it too.
    await expect(page.locator("#session-pane .cdash .cdash-answers")).toContainText("The history read is not it");
    // The earlier From subs card is gone.
    await expect(page.locator("#session-pane .cdash .cdash-reports")).toHaveCount(0);
    await capture(page.locator("#session-pane"), "chat-dashboard-finished-tray");
  });

  test("sits in the right column under the Plan card, while the Result is on the left", async ({ page }) => {
    await openMain(page, "dashboard");
    await expect(page.locator("#session-pane .cdash-left .cdash-resultcard")).toContainText("3 jobs handed to subs");
    expect((await tray(page).boundingBox())!.y).toBeGreaterThan((await page.locator("#session-pane .cdash-right .cdash-plan").boundingBox())!.y);
  });

  test("a click opens the finish card with the sub's name and text, and a second click closes it", async ({ page }) => {
    await openMain(page, "dashboard");
    await row(page, "sub-a").locator(".ft-main").click();
    const card = tray(page).locator('.ft-card .mc-root[data-sub-card="1"]');
    await expect(card.locator(".mc-full .mc-sub-name")).toHaveText("dup-subchat-toggle");
    await expect(card).toContainText("a CSS tie painted the hidden one");
    await row(page, "sub-a").locator(".ft-main").click();
    await expect(card).toHaveCount(0);
  });

  test("a card that lands live puts its sub's line in the tray", async ({ page }) => {
    await openMain(page, "dashboard");
    await expect(row(page, "sub-a").locator(".ft-line")).toHaveText("Not two toggles");
    await fireEvent(page, "subchat-card", [{ session_id: "main", card: finish("f-live", "sub-a", "dup-subchat-toggle", Date.now() + 1000, "Second round", "More.") }]);
    await expect(row(page, "sub-a").locator(".ft-line")).toHaveText("Second round");
  });

  test("Dismiss closes that sub through the app's own close and sends it no message", async ({ page }) => {
    await openMain(page, "dashboard");
    await row(page, "sub-a").hover();
    await row(page, "sub-a").locator(".ft-x").click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "clear_session").length).toBe(1);
    expect((await invokeCalls(page)).find((c) => c.cmd === "clear_session")!.args).toMatchObject({ sessionId: "sub-a" });
    expect((await invokeCalls(page)).filter((c) => c.cmd === "send_message")).toEqual([]);
  });

  test("Messages view draws the same finish cards in the transcript", async ({ page }) => {
    await openMain(page, "messages");
    const sub = page.locator('#session-pane .session-messages .mc-root[data-sub-card="1"]');
    // The page has an older one unloaded, so only cards from its first row on are placed here.
    await expect(sub.filter({ hasText: "Not two toggles" })).toHaveCount(1);
    await expect(sub.filter({ hasText: "The history read is not it" })).toHaveCount(1);
    await expect(sub.filter({ hasText: "Chips hide while typing" })).toHaveCount(0);
  });
});
