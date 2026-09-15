import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, fireEvent } from "./harness";

// Todo 899: the agent rail shows live Task/Agent subagents as avatars in the
// turn footer, without a click, so Joe can see "N guys working" and watch a
// dot die once its result lands. Real pipeline (sessions view + history/live
// events), matching the drive-the-real-thing convention of the checklist and
// tool-chip-panel specs.

const SHOTS = ".for_bepy/screenshots/_specs";
const RAIL = "#session-pane .session-messages .turn-footer .agent-rail";

const TODOS = [
  { content: "Sweep the logs", status: "completed", activeForm: "Sweeping the logs" },
  { content: "Delegate the rest", status: "in_progress", activeForm: "Delegating the rest" },
];

/** t1 finishes immediately (a ghost entry); t2/t3/t4 stay open (no
 *  tool_result) - the turn itself stays open too (no closing user_message),
 *  the state Joe actually watches. t2 gets one child tool_use so its "what
 *  it's doing right now" line has something real to show. */
function openDelegationTranscript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "Delegate the four things." }], timestamp: 0, remote_echo: false, is_meta: false },
    { type: "tool_use", tool_name: "TodoWrite", input: { todos: TODOS }, id: "tu-todo-1", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: "tu-todo-1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
    { type: "tool_use", tool_name: "Task", input: { description: "Sweep the logs" }, id: "t1", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "done" }, is_error: false, timestamp: 0 },
    { type: "tool_use", tool_name: "Task", input: { description: "Audit the config" }, id: "t2", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_use", tool_name: "Read", input: { file_path: "C:/p/notes.md" }, id: "c1", timestamp: 0, parent_tool_use_id: "t2" },
    { type: "tool_use", tool_name: "Task", input: { description: "Update the docs" }, id: "t3", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_use", tool_name: "Task", input: { description: "Run the tests" }, id: "t4", timestamp: 0, parent_tool_use_id: null },
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountOpenDelegation(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance({ busy: true, awaiting: null })],
      get_active_sessions: [sessionInstance({ busy: true, awaiting: null })],
      load_history_page: openDelegationTranscript(),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator(RAIL).waitFor();
}

test("three concurrent Task calls render three live dots, without any click", async ({ page }) => {
  await mountOpenDelegation(page);

  const liveDots = page.locator(`${RAIL} .tool-chip--agent-dot`);
  await expect(liveDots).toHaveCount(3); // t2, t3, t4 - t1 already finished

  // One finished call already folded into the ghost pill, unprompted.
  const ghost = page.locator(`${RAIL} .tool-chip--agent-ghost`);
  await expect(ghost.locator(".tool-chip-label")).toHaveText("1 done");
});

test("the rail sits above the checklist, as its own row", async ({ page }) => {
  await mountOpenDelegation(page);
  const railBox = (await page.locator(RAIL).boundingBox())!;
  const checklistBox = (await page.locator("#session-pane .session-messages .turn-footer .todo-checklist").boundingBox())!;
  expect(railBox.y).toBeLessThan(checklistBox.y);
});

test("clicking a live dot shows its label and its latest tool call", async ({ page }) => {
  await mountOpenDelegation(page);

  const panel = page.locator(RAIL).locator(".tool-strip-panel");
  await expect(panel).toBeHidden();

  const dot = page.locator(`${RAIL} .tool-chip--agent-dot[data-tool="t2"]`);
  await dot.click();
  await expect(panel).toBeVisible();

  const detail = page.locator(`${RAIL} .tool-strip-group[data-tool="t2"]`);
  await expect(detail).toBeVisible();
  await expect(detail.locator(".agent-rail-detail-label")).toHaveText("Audit the config");
  await expect(detail.locator(".agent-rail-detail-activity")).toHaveText(/Reading notes\.md/);
  // "Spawned during" names the step active when it spawned - never framed as
  // ownership (the todo's Variant-C-rejected note).
  await expect(detail.locator(".agent-rail-detail-spawned")).toHaveText(/Spawned during: Delegating the rest/);

  // Only t2's own panel opens - the [hidden] siblings (t3, t4, the ghost's
  // finished list) must not leak into view alongside it.
  await expect(page.locator(`${RAIL} .tool-strip-group[data-tool="t3"]`)).toBeHidden();
  await expect(page.locator(`${RAIL} .tool-strip-group[data-tool="t4"]`)).toBeHidden();
  await expect(page.locator(`${RAIL} .agent-rail-finished`)).toBeHidden();

  await page.locator(RAIL).screenshot({ path: `${SHOTS}/agent-rail-detail.png` });
});

test("the ghost pill lists what finished, spawned-during included", async ({ page }) => {
  await mountOpenDelegation(page);
  const ghost = page.locator(`${RAIL} .tool-chip--agent-ghost`);
  await ghost.click();
  const row = page.locator(`${RAIL} .agent-rail-finished-row`);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Sweep the logs");
  await expect(row).toContainText("Delegating the rest");
});

// Live transition: a dot has to actually die, not just vanish or get relabeled
// in place - Joe's own words ("i would want dead ones to actually die").
const LIVE_SESSION = sessionInstance({ busy: true, awaiting: null });
const LIVE_CHANNEL = `chat:${LIVE_SESSION.session_id}`;

async function mountLiveChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [LIVE_SESSION],
      get_active_sessions: [LIVE_SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${LIVE_SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, LIVE_CHANNEL);
}

test("a finished dot plays its death animation, then the ghost pill absorbs it", async ({ page }) => {
  await mountLiveChat(page);
  await fireEvent(page, LIVE_CHANNEL, [
    // remote_echo: true, or event-store.ts drops it as a --resume replay and
    // no turn ever opens for the Task call to land in.
    { type: "user_message", content: [{ type: "text", text: "Go do the thing." }], timestamp: 0, remote_echo: true, is_meta: false },
    { type: "tool_use", tool_name: "Task", input: { description: "One-off sweep" }, id: "d1", timestamp: 0, parent_tool_use_id: null },
  ]);

  const dot = page.locator(`${RAIL} .tool-chip--agent-dot[data-tool="d1"]`);
  await expect(dot).toHaveCount(1);
  await expect(page.locator(`${RAIL} .tool-chip--agent-ghost`)).toHaveCount(0);

  await fireEvent(page, LIVE_CHANNEL, [
    { type: "tool_result", tool_use_id: "d1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
  ]);

  // The ghost pill's count is correct the instant the result lands - it does
  // not wait out the death animation to be trustworthy.
  await expect(page.locator(`${RAIL} .tool-chip--agent-ghost .tool-chip-label`)).toHaveText("1 done");
  await expect(dot).toHaveClass(/tool-chip--agent-dot-dying/);

  // The dying dot is a real, temporary DOM state, not an instant swap.
  await expect(dot).toHaveCount(1);
  // Once the animation (and its timeout fallback) completes, the dot is gone
  // for good - only the ghost pill remembers it ran.
  await expect(dot).toHaveCount(0, { timeout: 2000 });
  await expect(page.locator(`${RAIL} .tool-chip--agent-dot`)).toHaveCount(0);
});
