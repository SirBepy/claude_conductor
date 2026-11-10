// Reviewed 2026-11-10 (dash lane 3): the Subchats zone is now the Subchats card fed by the instance list instead of the transcript's sub cards; no spec here has a sub, so nothing asserted changed and it passes.
// Reviewed 2026-11-10 (dash-extras): the Links and files, Preview window and Changes zones join ZONES, a Links card draws once a chat has a plan, and a question carries its message figures; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (dash-answers): the Answers zone is now the Answers card (answers-card.ts) drawing its verdict in .ax-face, so `.cdash-answers .mc-verdict` still holds; a kindless message moved to Notes. Passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/chat-dashboard/chat-view-pref.ts, src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/active-session-mount.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A real chat opened in Dashboard view draws its zones from its own history:
// Joe's latest message in the strip under the title, Answers and Waiting on
// you in the left column, Plan (then the Result in its spot) in the right one,
// the transcript hidden but still built underneath, and the composer where it
// always is. In Messages view the same chat is the plain transcript.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";

let n = 0;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`) => [
  { type: "tool_use", tool_name, input, id, timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const user = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0 });

const MID_JOB = [
  user("we should support trello as an option here"),
  ...tool("mcp__cc_conductor__report_turn_status", { status: "done" }),
  user("does it link tr- numbers like the shortcut ones? Also the hover card, and the board id should live next to the Shortcut one in project settings, not in a separate modal. And a pasted trello.com/c link from another board, does that get the same hover card, or does it stay a plain link until someone adds that board to the project? I would rather it stayed plain than showed the wrong card."),
  ...tool(SEND, { kind: "answer", verdict: "Yes, once the board confirms", tone: "good", text: "tr-12 becomes a link only after Trello confirms card 12 is on that board.\nA wrong board id stays plain text." }),
  ...tool("mcp__cc_conductor__write_plan", { steps: [
    { text: "Read the Shortcut tracker code", status: "done", detail: "How the Shortcut tracker reads ids and links." },
    { text: "Add Trello with a board id", status: "done" },
    { text: "Link tr- numbers once the board confirms", status: "active", detail: "tr-12 becomes a link only after Trello confirms card 12." },
    { text: "Run frontend and Rust tests", status: "pending" },
  ] }),
  ...tool(SEND, { kind: "blocker", verdict: "Stuck on the API key", text: "The Trello key is not in the key modal yet." }),
];
const FINISHED = [
  ...MID_JOB,
  user("the key is in now"),
  ...tool("mcp__cc_conductor__write_plan", { steps: [
    { text: "Read the Shortcut tracker code", status: "done" },
    { text: "Add Trello with a board id", status: "done" },
    { text: "Link tr- numbers once the board confirms", status: "done" },
    { text: "Run frontend and Rust tests", status: "done" },
  ] }),
  ...tool(SEND, {
    kind: "report", verdict: "Trello is in", tone: "good", text: "Trello works as a ticket tracker next to Shortcut and Linear.",
    done: ["Board id per project", "tr- links after the board confirms"], your_move: ["Try a tr- link in a chat"],
    visuals: [{ type: "table", title: "Trackers", columns: ["Tracker", "Link form"], rows: [["Shortcut", "sc-12"], ["Trello", "tr-12"]] }],
  }),
  ...tool("mcp__cc_conductor__report_turn_status", { status: "done" }),
];

async function openChat(page: Page, history: unknown[], chatView: "dashboard" | "messages", session = SESSION): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView,
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [session],
      get_active_sessions: [session],
      load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const pane = (page: Page) => page.locator("#session-pane");
const dash = (page: Page) => page.locator("#session-pane .cdash");

test.describe("chat dashboard", () => {
  test("a chat mid-job: strip, Answers and Waiting on the left, Plan on the right, transcript hidden", async ({ page }) => {
    await openChat(page, MID_JOB, "dashboard");
    await expect(dash(page)).toBeVisible();
    await expect(page.locator("#session-pane .session-messages")).toBeHidden();
    // The composer stays where it always is, below the dashboard.
    await expect(page.locator("#session-pane .session-composer")).toBeVisible();

    const strip = dash(page).locator(".cdash-strip");
    await expect(strip.locator(".cdash-strip-msg")).toContainText("does it link tr- numbers");
    await expect(strip.locator("[data-act='strip-earlier']")).toHaveText(/1 earlier/);
    // Clamped at rest, whole once clicked.
    const clamped = await strip.locator(".cdash-strip-text").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(clamped).toBe(true);

    const left = dash(page).locator(".cdash-left");
    const right = dash(page).locator(".cdash-right");
    await expect(left.locator(".cdash-slot")).toHaveCount(2);
    await expect(left.locator(".cdash-slot").nth(0)).toHaveAttribute("data-zone", "answers");
    await expect(left.locator(".cdash-slot").nth(1)).toHaveAttribute("data-zone", "waiting");
    await expect(left.locator(".cdash-answers .mc-verdict")).toHaveText("Yes, once the board confirms");
    await expect(left.locator(".cdash-waiting")).toHaveClass(/is-blocked/);
    await expect(left.locator(".cdash-waiting .mc-verdict")).toHaveText("Stuck on the API key");
    await expect(right.locator(".cdash-plan .cdash-count")).toHaveText("2/4");

    // Left column is what Joe must look at, so it sits left of the plan.
    const lb = (await left.boundingBox())!;
    const rb = (await right.boundingBox())!;
    expect(lb.x + lb.width).toBeLessThanOrEqual(rb.x);
    expect(Math.abs(lb.y - rb.y)).toBeLessThan(2);

    await right.locator("button.cdash-step").nth(1).click();
    await expect(right.locator(".cdash-step-d")).toHaveText("tr-12 becomes a link only after Trello confirms card 12.");
    await capture(pane(page), "chat-dashboard-mid-job");

    await strip.locator(".cdash-strip-msg").click();
    await expect(strip.locator(".cdash-strip-msg")).toHaveClass(/open/);
    await strip.locator("[data-act='strip-earlier']").click();
    await expect(strip.locator(".cdash-pop-row")).toHaveCount(2);
    await capture(pane(page), "chat-dashboard-earlier-open");
  });

  test("a finished job: the Result takes the Plan card's spot, Plan N/N flips back", async ({ page }) => {
    await openChat(page, FINISHED, "dashboard");
    const right = dash(page).locator(".cdash-right");
    await expect(right.locator(".cdash-result .mc-verdict")).toHaveText("Trello is in");
    await expect(right.locator(".cdash-result table")).toBeVisible();
    // Joe wrote after the blocker, so it no longer waits on him.
    await expect(dash(page).locator(".cdash-waiting")).toHaveCount(0);
    await expect(right.locator("[data-act='show-plan']")).toHaveText("Plan 4/4");
    await capture(pane(page), "chat-dashboard-result");
    await right.locator("[data-act='show-plan']").click();
    await expect(right.locator(".cdash-plan .cdash-step")).toHaveCount(4);
    await expect(right.locator("[data-act='show-result']")).toBeVisible();
  });

  test("a running turn: the status line sits at the foot of the Plan card, not above the message box", async ({ page }) => {
    await openChat(page, [user("we should support trello as an option here")], "dashboard", sessionInstance({ busy: true, awaiting: null }));
    const plan = dash(page).locator(".cdash-right .cdash-plan");
    await expect(plan.locator("[data-slot='status'] .session-thinking")).toBeVisible();
    await expect(plan.locator(".thinking-text")).not.toHaveText("");
    await expect(page.locator("#session-pane .composer-shell > .session-thinking")).toHaveCount(0);
    await capture(pane(page), "chat-dashboard-running");
  });

  test("Messages view is the plain transcript with no dashboard", async ({ page }) => {
    await openChat(page, MID_JOB, "messages");
    await expect(page.locator("#session-pane .session-messages .mc-root").first()).toBeVisible();
    await expect(dash(page)).toHaveCount(0);
    await expect(pane(page)).not.toHaveAttribute("data-chat-view", /.*/);
  });
});
