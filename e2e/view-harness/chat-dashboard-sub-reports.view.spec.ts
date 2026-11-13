// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/shared/chat/subchat-cards.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A main chat's dashboard draws its subs' reports in From subs (Joe, 2026-11-13:
// "i dont see subchats answers in the main chat window"). The main chat is told
// never to relay a sub's card, and before this zone a job's finish showed on the
// dashboard only as a verdict behind a click on the sub's avatar. Each report is
// the same card Messages view draws: the sub's name, its verdict and its text.

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
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
}

const reports = (page: Page) => page.locator("#session-pane .cdash .cdash-reports");

test.describe("chat dashboard / From subs", () => {
  test("draws each job's finish with the sub's name and text, newest first, and leaves the answer to Answers", async ({ page }) => {
    await openMain(page, "dashboard");
    await expect(reports(page)).toBeVisible();
    const cards = reports(page).locator('.mc-root[data-sub-card="1"]');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).locator(".mc-full .mc-sub-name")).toHaveText("dup-subchat-toggle");
    await expect(cards.nth(0).locator(".mc-full .mc-verdict")).toHaveText("Not two toggles");
    await expect(cards.nth(0)).toContainText("a CSS tie painted the hidden one");
    // The report older than every loaded transcript row still shows.
    await expect(cards.nth(1).locator(".mc-full .mc-sub-name")).toHaveText("hide-chips-on-input");
    await expect(cards.nth(1)).toContainText("The draft screen's chip row hides");
    // A finish carrying Joe's question is the answer: it is in Answers, not here.
    await expect(reports(page)).not.toContainText("The history read is not it");
    await expect(page.locator("#session-pane .cdash .cdash-answers")).toContainText("The history read is not it");
    await capture(page.locator("#session-pane"), "chat-dashboard-sub-reports");
  });

  test("a card that lands live shows at once, and past three the rest fold under N earlier", async ({ page }) => {
    await openMain(page, "dashboard");
    await expect(reports(page).locator('.mc-root[data-sub-card="1"]')).toHaveCount(2);
    for (const [i, id] of ["f-live1", "f-live2"].entries()) {
      await fireEvent(page, "subchat-card", [{ session_id: "main", card: finish(id, `sub-${id}`, `live-${i}`, Date.now() + i, `Live verdict ${i}`, `Live text ${i}`) }]);
    }
    await expect(reports(page)).toContainText("Live verdict 1");
    await expect(reports(page).locator('.mc-root[data-sub-card="1"]')).toHaveCount(3);
    const fold = reports(page).locator("[data-act='reports-earlier']");
    await expect(fold).toContainText("1 earlier");
    await expect(reports(page)).not.toContainText("The draft screen's chip row hides");
    await fold.click();
    await expect(reports(page)).toContainText("The draft screen's chip row hides");
  });

  test("Messages view draws the same finish cards in the transcript", async ({ page }) => {
    await openMain(page, "messages");
    const sub = page.locator('#session-pane .session-messages .mc-root[data-sub-card="1"]');
    // The page has an older one unloaded, so only cards from its first row on are placed here.
    await expect(sub.filter({ hasText: "Not two toggles" })).toHaveCount(1);
    await expect(sub.filter({ hasText: "The history read is not it" })).toHaveCount(1);
  });
});
