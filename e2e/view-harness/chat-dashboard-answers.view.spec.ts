// Reviewed 2026-11-10 (dash lane 3): chat-dashboard.ts and dashboard-zones.ts gained the Subchats card's host and wiring; this spec's chats have no subs and the Answers card is untouched, so it passes.
// Reviewed 2026-11-10 (dash-extras): the dashboard gained the Links and files, Preview window and Changes zones and reads list_previews/chat_quick_view (both caught when unmocked); the Answers card is untouched, and this spec passes.
// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-card.css, src/views/sessions/chat-dashboard/answers-api.ts, src/shared/chat/dashboard/answers-model.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The dashboard's Answers card in the real app shell (docs/chat-dashboard-design.md,
// "Answers card"): it rests at 210px with its buttons on the bottom edge, Got it
// walks back through the unread answers with only the text moving, and the last
// one fades to All caught up. A chat whose answers the daemon already has marked
// read opens straight on All caught up.

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

    // Read more opens the rewritten question above the full text.
    await c.locator(".ax-readmore").click();
    await expect(c.locator(".ax-face")).toHaveClass(/open/);
    await expect(c.locator(".ax-qline span")).toHaveText("Does the Trello token need write access?");
    await expect(c.locator(".ax-qline time")).not.toHaveText("");
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

  test("a chat whose answers are already read opens on All caught up, with History grouped", async ({ page }) => {
    await openChat(page, { read: { a1: 1, a2: 1, a3: 1 }, threads: {}, questions: [] });
    const c = card(page);
    await expect(c.locator(".ax-cc-t")).toHaveText("All caught up");
    await c.locator(".ax-cc [data-ax='history']").click();
    const rows = page.locator(".cp-row .cp-title");
    await expect(rows).toHaveText(["Does the Trello token need write access?", "Do tr- numbers link the way Shortcut's sc- numbers do?", "Does Trello reuse the Shortcut tracker, or start from scratch?"]);
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
