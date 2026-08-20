import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Todo 662: the TodoWrite step checklist shipped fully built and was never once
// seen on screen, because nothing covered the seam between the event and the
// DOM. These specs drive the REAL pipeline (sessions view + load_history_page)
// so a silent drop between the two shows up as red.

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  get_usage_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  poll_now: null,
  list_projects: [],
  resolve_whitelist_characters: [],
  probe_models_availability: [],
  list_accounts: [],
  list_scheduled_messages: [],
  list_session_characters: {},
  watch_session_transcript: null,
  unwatch_session_transcript: null,
  session_live_cwd: null,
  get_git_info: null,
  get_session_counts: null,
  get_context_status: null,
  get_session_drain: null,
  list_pending_prompts: [],
  get_chat_config: null,
};

function instance(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "s1", pid: 100, cwd: "C:/Projects/alpha",
    project_id: "p1", kind: "interactive", is_remote: false,
    started_at: "2026-08-01T10:00:00Z", transcript_path: null, bridge_session_id: null,
    name: "Alpha chat", ended_at: null, end_reason: null,
    busy: true, model: "claude-opus-5", effort: "high", awaiting: null,
    autopilot: false, jarvis: false, worker_of: null, closing: false,
    account_id: null, rate_limited_resets_at: null, rate_limited_type: null,
    ...over,
  };
}

const TODOS = [
  { content: "Read the spec", status: "completed", activeForm: "Reading the spec" },
  { content: "Wire the feed", status: "in_progress", activeForm: "Wiring the feed" },
  { content: "Add the view spec", status: "pending", activeForm: "Adding the view spec" },
];

// No turn_usage: the turn stays OPEN, which is the state Joe watches. A settled
// turn collapses every row into a single "N steps" chip.
function todoTranscript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "Do the three things." }], timestamp: 0, remote_echo: false, is_meta: false },
    { type: "tool_use", tool_name: "TodoWrite", input: { todos: TODOS }, id: "tu-todo-1", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: "tu-todo-1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountTodoChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...BASE_INVOKE,
      list_instances: [instance()],
      get_active_sessions: [instance()],
      load_history_page: todoTranscript(),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-messages").first().waitFor();
}

test("a turn's TodoWrite renders the step checklist in the turn footer", async ({ page }) => {
  await mountTodoChat(page);

  const checklist = page.locator("#session-pane .session-messages .turn-footer .todo-checklist");
  await expect(checklist).toHaveCount(1);

  const rows = checklist.locator(".todo-checklist-steps > li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveText(/Read the spec/);
  await expect(rows.nth(1)).toHaveText(/Wire the feed/);
  await expect(rows.nth(2)).toHaveText(/Add the view spec/);

  await expect(rows.nth(0)).toHaveClass(/todo-step--done/);
  await expect(rows.nth(1)).toHaveClass(/todo-step--active/);
  await expect(rows.nth(0).locator(".todo-step-icon i")).toHaveClass(/ph-check-circle/);
  await expect(rows.nth(1).locator(".todo-step-icon i")).toHaveClass(/ph-spinner-gap/);

  // On screen, not merely in the DOM: an off-layout or zero-height checklist is
  // exactly the failure mode nobody noticed for weeks.
  await expect(checklist).toBeVisible();
  expect((await checklist.boundingBox())!.height).toBeGreaterThan(40);
  for (let i = 0; i < 3; i++) {
    expect((await rows.nth(i).boundingBox())!.height).toBeGreaterThan(10);
  }
});

// KNOWN BREAK, turn-todo-checklist.ts:106-110 (outside this change's file set):
// a freshly created row is initialised `status: "pending"` and only styled
// `if (entry.status !== step.status)`, so a step that ARRIVES pending is never
// passed to applyTodoStepStatus - no `todo-step` class, empty icon span.
test.fail("a pending step renders its empty circle", async ({ page }) => {
  await mountTodoChat(page);
  const rows = page.locator("#session-pane .session-messages .todo-checklist .todo-checklist-steps > li");
  await expect(rows.nth(2)).toHaveClass(/todo-step--pending/);
  await expect(rows.nth(2).locator(".todo-step-icon i")).toHaveClass(/ph-circle/);
});

test("a step patches pending -> active -> done in place, then collapses on settle", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });

  await page.evaluate(async () => {
    await import("/views/sessions/sessions.ts");
    const { TurnFooterRegistry } = await import("/shared/chat/turn-chips.ts");
    const el = document.createElement("div");
    el.id = "todo-harness";
    el.className = "chat-messages";
    el.style.cssText = "padding:16px;max-width:720px";
    document.body.replaceChildren(el);
    const reg = new TurnFooterRegistry();
    el.appendChild(reg.getOrCreateFooter(1));
    (window as unknown as { __reg: TurnFooterRegistry }).__reg = reg;
  });

  const host = page.locator("#todo-harness");
  const rows = host.locator(".todo-checklist-steps > li");
  const drive = (steps: { label: string; status: string }[]) =>
    page.evaluate((s) => {
      (window as unknown as { __reg: { updateTodoSteps: (k: number, v: unknown) => void } })
        .__reg.updateTodoSteps(1, s);
    }, steps);

  const labels = ["Read the spec", "Wire the feed", "Add the view spec"];
  await drive(labels.map((label) => ({ label, status: "pending" })));
  await expect(rows).toHaveCount(3);

  await drive(labels.map((label, i) => ({ label, status: i === 0 ? "active" : "pending" })));
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveClass(/todo-step--active/);
  await expect(rows.nth(0).locator(".todo-step-icon i")).toHaveClass(/ph-spinner-gap/);

  await drive(labels.map((label, i) => ({ label, status: i === 0 ? "done" : i === 1 ? "active" : "pending" })));
  await expect(rows.nth(0)).toHaveClass(/todo-step--done/);
  await expect(rows.nth(0).locator(".todo-step-icon i")).toHaveClass(/ph-check-circle/);
  await expect(rows.nth(1)).toHaveClass(/todo-step--active/);
  // Connector fills to 100% behind a completed step.
  await expect(rows.nth(0).locator(".todo-step-connector-fill")).not.toHaveCSS("height", "0px");

  await page.evaluate(() => {
    (window as unknown as { __reg: { settleTodoChecklist: (k: number) => void } }).__reg.settleTodoChecklist(1);
  });
  await expect(rows).toHaveCount(0);
  await expect(host.locator(".todo-checklist-collapsed .turn-chip")).toHaveText(/3 steps/);
});
