// Reviewed 2026-11-12 (shown badly): chat-dashboard.ts adds a contextmenu listener for the card menu's "Shown badly" item (chat-shown-badly.view.spec.ts covers it); nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (honest sub states): subs gained queued/paused/usage-limit/stopped kinds with a dim ring and glyph, an avatar hover card, the Plan foot's sub counts and a glowing main-chat ring; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (per-chat previews): the Preview card lists only the previews this chat pushed (newest big, the rest as a thumbnail strip) and folds the family's others behind "N more by other chats"; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (answers pending row): answers-model.ts adds a row per question handed to a sub (spawn_chat, read-only, report_back) until its answer fills it, and the dashboard passes the sub list only once it holds this chat; this spec has no hand-off, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (dashboard Drafts card): a new left-column zone draws write_draft drafts and the dashboard reads the drafts store; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/session-thinking-bar.ts, src/shared/chat/dashboard/dashboard-model.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The Plan card across a chat's life (docs/chat-dashboard-design.md "Plan card
// across a chat's life"), one real chat per moment: a brand-new chat, a plan
// running, the job ended, the last job kept after a follow-up, a new plan with
// the old one a step back, an earlier plan open, the list of earlier plans, and
// the status line saying what Claude is doing. Each moment is captured.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const STATUS = "mcp__cc_conductor__report_turn_status";

let n = 0;
const T0 = Date.UTC(2026, 10, 10, 13, 40);
const min = (m: number) => T0 + m * 60_000;
const tool = (tool_name: string, input: Record<string, unknown>, ts = 0, id = `t${++n}`) => [
  { type: "tool_use", tool_name, input, id, timestamp: ts, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: ts },
];
const user = (text: string, ts = 0) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: ts });
const steps = (labels: string[], done: number) => labels.map((text, i) => ({ text, status: i < done ? "done" : i === done ? "active" : "pending" }));

/** One job: Joe asks at `at` minutes, Claude plans, ticks a step a minute, reports. */
function job(at: number, ask: string, lead: string, labels: string[], verdict: string, text: string): unknown[] {
  const out: unknown[] = [user(ask, min(at)), ...tool(SEND, { kind: "plan", text: lead }, min(at))];
  for (let d = 0; d <= labels.length; d++) out.push(...tool(PLAN, { steps: steps(labels, d) }, min(at + 1 + d)));
  out.push(...tool(SEND, { kind: "report", verdict, tone: "good", text }, min(at + labels.length + 2)));
  out.push(...tool(STATUS, { status: "done" }, min(at + labels.length + 2)));
  return out;
}

const TRELLO = job(0, "sync trello cards into the todo list", "Read the tracker code, add a Trello source, then test it.",
  ["Read the tracker code", "Add the Trello source", "Map labels to tags", "Write tests", "Commit"], "Built, not pushed", "Trello cards land in Todos every 5 minutes.");
const FOLLOW_UP = [
  user("does it skip archived cards?", min(12)),
  ...tool(SEND, { kind: "answer", verdict: "Yes", question: "Does the sync skip archived Trello cards?", text: "Archived cards never reach Todos." }, min(13)),
  ...tool(STATUS, { status: "done" }, min(13)),
];
const DUE_DATES = [
  user("also show each card's due date", min(25)),
  ...tool(SEND, { kind: "plan", text: "Add a due date chip to Trello todos." }, min(25)),
  ...tool(PLAN, { steps: steps(["Read the card fields", "Add the due date chip", "Test it"], 0) }, min(26)),
  ...tool(PLAN, { steps: steps(["Read the card fields", "Add the due date chip", "Test it"], 1) }, min(28)),
];
const MANY = Array.from({ length: 9 }, (_, i) => job(i * 20, `job number ${i + 1}`, i === 3 ? "Add the Trello board id." : `Plan number ${i + 1}.`, ["Read", "Change", "Test"], `Done ${i + 1}`, "ok")).flat();

async function openChat(page: Page, history: unknown[], session = SESSION): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
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
const plan = (page: Page) => page.locator("#session-pane .cdash-right .cdash-plan");

test.describe("the Plan card across a chat's life", () => {
  test("a brand-new chat: an empty Answers card and an empty Plan card", async ({ page }) => {
    await openChat(page, []);
    await expect(plan(page).locator(".cdash-pnone")).toHaveText("Nothing planned yet.");
    await expect(page.locator("#session-pane .cdash-left .ax-empty")).toContainText("No answers yet");
    await capture(pane(page), "plan-1-new-chat");
  });

  test("a plan running, then a step opened for when it ran", async ({ page }) => {
    await openChat(page, [...TRELLO.slice(0, 12)]);
    await expect(plan(page).locator(".cdash-h-t")).toHaveText("Plan");
    await expect(plan(page).locator(".cdash-step--active")).toHaveCount(1);
    await capture(pane(page), "plan-2-running");
    await plan(page).locator("button.cdash-step").first().click();
    await expect(plan(page).locator(".cdash-step-t")).toHaveText(/ to /);
    await expect(plan(page).locator(".cdash-step-len")).toHaveText("1 min");
    await capture(plan(page), "plan-3-step-opened");
  });

  test("the job ended: the Result under its steps", async ({ page }) => {
    await openChat(page, TRELLO);
    await expect(plan(page)).toHaveClass(/is-result/);
    await expect(plan(page).locator(".cdash-step--done")).toHaveCount(5);
    await expect(plan(page).locator(".cdash-pstatus")).toContainText("Idle since");
    await capture(pane(page), "plan-4-result");
  });

  test("a job that ended with steps never ticked off draws them as left open, not running", async ({ page }) => {
    const labels = ["Read the tracker code", "Add the Trello source", "Map labels to tags", "Write tests", "Commit"];
    await openChat(page, [
      user("sync trello cards into the todo list", min(0)),
      ...tool(PLAN, { steps: steps(labels, 0) }, min(1)),
      ...tool(PLAN, { steps: steps(labels, 3) }, min(4)),
      ...tool(STATUS, { status: "done" }, min(6)),
    ]);
    await expect(plan(page).locator(".cdash-step--active")).toHaveCount(0);
    await expect(plan(page).locator(".cdash-step--left")).toHaveCount(2);
    await expect(plan(page).locator(".cdash-step--left i.ph-circle-dashed")).toHaveCount(2);
    await capture(pane(page), "plan-12-left-open");
  });

  test("a plan message's lines after its headline stay on the card, so a plan with no write_plan steps can be read", async ({ page }) => {
    await openChat(page, [
      user("build the Greek release", min(0)),
      ...tool(SEND, { kind: "plan", text: "Proposed plan for the Greek build:\n\n- Commit the signing-team change\n- Bump to +15 and upload to TestFlight" }, min(1)),
    ]);
    await expect(plan(page).locator(".cdash-plan-lead")).toHaveText("Proposed plan for the Greek build:");
    await expect(plan(page).locator(".cdash-plan-body li")).toHaveText(["Commit the signing-team change", "Bump to +15 and upload to TestFlight"]);
    await capture(plan(page), "plan-13-message-body");
  });

  test("a follow-up with no new plan keeps the job, dimmed, as the last job", async ({ page }) => {
    await openChat(page, [...TRELLO, ...FOLLOW_UP]);
    await expect(plan(page)).toHaveClass(/is-last/);
    await expect(plan(page).locator(".cdash-h-t")).toHaveText(/^Last job/);
    await expect(plan(page).locator(".cdash-dim .cdash-result")).toContainText("Built, not pushed");
    await capture(pane(page), "plan-5-last-job");
  });

  test("a new plan takes the card; the old one is a step back, and the foot leads home", async ({ page }) => {
    await openChat(page, [...TRELLO, ...FOLLOW_UP, ...DUE_DATES]);
    await expect(plan(page).locator(".cdash-h-t")).toHaveText("Plan");
    await expect(plan(page).locator(".cdash-pnav-mid")).toHaveText("1");
    await capture(pane(page), "plan-6-new-plan");
    // The pager's three slots never move as Joe steps back.
    const before = (await plan(page).locator("[data-act='plan-prev']").boundingBox())!;
    await plan(page).locator("[data-act='plan-prev']").click();
    await expect(plan(page)).toHaveClass(/is-earlier/);
    await expect(plan(page).locator(".cdash-pnav-mid")).toHaveText("1 / 2");
    const after = (await plan(page).locator("[data-act='plan-prev']").boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    await expect(plan(page).locator(".cdash-status.is-away")).toBeVisible();
    await page.waitForTimeout(500);
    await capture(pane(page), "plan-7-earlier-plan");
    await plan(page).locator(".cdash-status.is-away").click();
    await expect(plan(page).locator(".cdash-h-t")).toHaveText("Plan");
  });

  test("the list of earlier plans fills the card, searchable, with no scrollbar", async ({ page }) => {
    await openChat(page, [...MANY, user("one more", min(200)), ...tool(PLAN, { steps: steps(["Go"], 0) }, min(201))]);
    await plan(page).locator("[data-act='plan-list']").click();
    await expect(plan(page)).toHaveClass(/is-list/);
    await expect(plan(page).locator(".cdash-pl-row")).toHaveCount(9);
    await expect(plan(page).locator(".cdash-pl-search input")).toBeFocused();
    const bar = await plan(page).locator(".cdash-pl").evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth);
    expect(bar).toBe(0);
    await page.waitForTimeout(500);
    await capture(pane(page), "plan-8-list");
    await page.keyboard.type("trello");
    await expect(plan(page).locator(".cdash-pl-row:visible")).toHaveCount(1);
    await capture(plan(page), "plan-9-list-search");
    await page.keyboard.press("Escape");
    await expect(plan(page)).not.toHaveClass(/is-list/);
  });

  test("a turn running: the status line says what Claude is doing, and opens to the turn's calls", async ({ page }) => {
    const running = [
      ...TRELLO, ...FOLLOW_UP,
      user("also show each card's due date"),
      ...tool(PLAN, { steps: steps(["Read the card fields", "Add the due date chip", "Test it"], 1) }),
      ...tool("Read", { file_path: "C:/repo/src/trello/card.ts" }),
      ...tool("Grep", { pattern: "dueDate" }),
      { type: "tool_use", tool_name: "Edit", input: { file_path: "C:/repo/src/trello/todo-chip.ts", old_string: "a", new_string: "b" }, id: "live-edit", timestamp: 0, parent_tool_use_id: null },
    ];
    await openChat(page, running, sessionInstance({ busy: true, awaiting: null }));
    const bar = plan(page).locator("[data-slot='status'] .session-thinking");
    await expect(bar).toBeVisible();
    await expect(bar.locator(".thinking-text")).toContainText("todo-chip.ts");
    await expect(bar.locator(".thinking-icon")).toHaveClass(/ph-pencil-simple/);
    await capture(pane(page), "plan-10-status-line");
    await bar.locator(".thinking-main").click();
    await expect(bar.locator(".thinking-counts")).toContainText("This turn:");
    await expect(bar.locator(".thinking-trail-row")).toHaveCount(2);
    await capture(plan(page), "plan-11-status-opened");
  });
});
