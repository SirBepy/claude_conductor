import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The `write_plan` half of the checklist seam (todo 662: a fully built renderer
// went unseen for weeks with nothing covering event-to-DOM), so these drive the
// REAL pipeline. Two properties TodoWrite's own spec cannot cover: every step
// renders from the first call, and a step carrying a `detail` expands on click.

const STEPS = [
  { text: "Read the spec", status: "done", detail: "Both the todo and the linked commits." },
  { text: "Wire the feed", status: "done" },
  { text: "Add the view spec", status: "active", detail: "Drive the real pipeline, not the renderer." },
  { text: "Run the fast checks", status: "pending" },
  { text: "Commit", status: "pending", detail: "By pathspec - the tree is shared." },
];

function planTranscript(steps: unknown[]) {
  return {
    events: [
      { type: "user_message", content: [{ type: "text", text: "Do the five things." }], timestamp: 0, remote_echo: false, is_meta: false },
      {
        type: "tool_use",
        tool_name: "mcp__cc_conductor__write_plan",
        input: { steps },
        id: "tu-plan-1",
        timestamp: 0,
        parent_tool_use_id: null,
      },
      { type: "tool_result", tool_use_id: "tu-plan-1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
    ],
    oldest_seq: 0,
    newest_seq: 0,
    has_more: false,
  };
}

async function mountPlanChat(page: Page, steps: unknown[] = STEPS): Promise<void> {
  const instance = sessionInstance({ busy: true, awaiting: null });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [instance],
      get_active_sessions: [instance],
      load_history_page: planTranscript(steps),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-messages").first().waitFor();
}

const ROWS = "#session-pane .session-messages .turn-footer .todo-checklist .todo-checklist-steps > li";

test("a write_plan call renders the WHOLE plan, pending steps included", async ({ page }) => {
  await mountPlanChat(page);

  const rows = page.locator(ROWS);
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveClass(/todo-step--done/);
  await expect(rows.nth(2)).toHaveClass(/todo-step--active/);
  // The point of the feature: step 4 is legible while step 3 is still running.
  await expect(rows.nth(3)).toHaveClass(/todo-step--pending/);
  await expect(rows.nth(4)).toHaveText(/Commit/);
  await expect(rows.nth(3)).toBeVisible();
});

test("only steps that carry a detail get a caret", async ({ page }) => {
  await mountPlanChat(page);
  const rows = page.locator(ROWS);
  await expect(rows.nth(0)).toHaveClass(/todo-step--has-detail/);
  await expect(rows.nth(1)).not.toHaveClass(/todo-step--has-detail/);
  await expect(rows.nth(0).locator(".todo-step-caret")).toHaveCount(1);
  await expect(rows.nth(1).locator(".todo-step-caret")).toHaveCount(0);
});

test("clicking a step reveals its detail, and clicking again hides it", async ({ page }) => {
  await mountPlanChat(page);
  const row = page.locator(ROWS).nth(0);
  const detail = row.locator(".todo-step-detail");

  // In the DOM from the start, so assert on visibility rather than count -
  // a detail that renders but is off-layout is the failure todo 662 hit.
  await expect(detail).toBeHidden();
  await row.click();
  await expect(detail).toBeVisible();
  await expect(detail).toHaveText("Both the todo and the linked commits.");
  expect((await detail.boundingBox())!.height).toBeGreaterThan(8);

  await row.click();
  await expect(detail).toBeHidden();
});

// applyTodoStepStatus rebuilds className, which silently dropped every class
// the detail code adds. An expandable step stopped expanding the instant it
// changed status - invisible in any test that never advances a step, which is
// why this drives the registry directly rather than mounting a transcript.
test("a step stays expandable, and stays open, after its status changes", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });

  await page.evaluate(async () => {
    await import("/views/sessions/sessions.ts");
    const { TurnFooterRegistry } = await import("/shared/chat/turn-chips.ts");
    const el = document.createElement("div");
    el.id = "plan-harness";
    el.className = "chat-messages";
    el.style.cssText = "padding:16px;max-width:720px";
    document.body.replaceChildren(el);
    const reg = new TurnFooterRegistry();
    el.appendChild(reg.getOrCreateFooter(1));
    (window as unknown as { __reg: InstanceType<typeof TurnFooterRegistry> }).__reg = reg;
  });

  const drive = (steps: { label: string; status: string; detail?: string }[]) =>
    page.evaluate((s) => {
      (window as unknown as { __reg: { updateTodoSteps: (k: number, v: unknown) => void } })
        .__reg.updateTodoSteps(1, s);
    }, steps);

  const row = page.locator("#plan-harness .todo-checklist-steps > li").first();
  const detail = row.locator(".todo-step-detail");

  await drive([{ label: "Wire the feed", status: "pending", detail: "Through the real pipeline." }]);
  await row.click();
  await expect(detail).toBeVisible();

  await drive([{ label: "Wire the feed", status: "active", detail: "Through the real pipeline." }]);
  await expect(row).toHaveClass(/todo-step--active/);
  await expect(row).toHaveClass(/todo-step--has-detail/);
  await expect(detail).toBeVisible();

  await drive([{ label: "Wire the feed", status: "done", detail: "Through the real pipeline." }]);
  await expect(row).toHaveClass(/todo-step--done/);
  await expect(detail).toBeVisible();
});

// A plan that drops a step's detail must drop its caret too, or the row keeps
// a control that opens an empty box.
test("removing a detail removes the caret with it", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async () => {
    await import("/views/sessions/sessions.ts");
    const { TurnFooterRegistry } = await import("/shared/chat/turn-chips.ts");
    const el = document.createElement("div");
    el.id = "plan-harness";
    el.className = "chat-messages";
    document.body.replaceChildren(el);
    const reg = new TurnFooterRegistry();
    el.appendChild(reg.getOrCreateFooter(1));
    (window as unknown as { __reg: InstanceType<typeof TurnFooterRegistry> }).__reg = reg;
  });
  const drive = (steps: { label: string; status: string; detail?: string }[]) =>
    page.evaluate((s) => {
      (window as unknown as { __reg: { updateTodoSteps: (k: number, v: unknown) => void } })
        .__reg.updateTodoSteps(1, s);
    }, steps);

  const row = page.locator("#plan-harness .todo-checklist-steps > li").first();
  await drive([{ label: "Commit", status: "pending", detail: "By pathspec." }]);
  await expect(row.locator(".todo-step-caret")).toHaveCount(1);

  await drive([{ label: "Commit", status: "pending" }]);
  await expect(row.locator(".todo-step-caret")).toHaveCount(0);
  await expect(row).not.toHaveClass(/todo-step--has-detail/);
});
