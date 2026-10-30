// Reviewed 2026-10-30 (user-message attachment tray): chat-dom-renderer.ts now groups a USER message's attachment chips into a tray; this spec only asserts assistant pr_preview cards, so its contract is unchanged.
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, fireEvent } from "./harness";

// asserts: src/shared/chat/chat-pr-tool.ts, src/shared/chat/chat-event-handler-tools.ts, src/shared/chat/chat-dom-renderer.ts

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;

// The exact input of the 2026-10-25 live call (session e1c34648, tool_use
// toolu_01Undf61dnVGoDh5CoQeqA1q): a `#` and `:` and parentheses in the title.
const PR_INPUT = {
  title: "Live check for #1149: PR card via pr_preview (not a real PR)",
  body: "This is a **test card** from /loop-todos, checking that the `pr_preview` tool renders the PR card in Conductor. Nothing is being created.",
  commits: [{ sha: "af0dd98", msg: "FIX: /create-pr shows the Conductor PR card by calling the pr_preview tool" }],
};

const usage = {
  type: "turn_usage", input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, total_cost_usd: 0.001, duration_ms: 1200, has_thinking: false,
  model: null, awaiting: null, autopilot_changed: null,
};

const turn = () => [
  { type: "user_message", content: [{ type: "text", text: "go" }], timestamp: 0 },
  { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { text: "checking" }, id: "t1", parent_tool_use_id: null, timestamp: 0 },
  { type: "tool_result", tool_use_id: "t1", output: "ok", is_error: false, timestamp: 0 },
  { type: "tool_use", tool_name: "mcp__cc_conductor__pr_preview", input: PR_INPUT, id: "toolu_pr", parent_tool_use_id: null, timestamp: 0 },
  { type: "tool_result", tool_use_id: "toolu_pr", output: "PR preview card shown in chat", is_error: false, timestamp: 0 },
  { type: "tool_use", tool_name: "mcp__cc_conductor__report_turn_status", input: { awaiting: "working" }, id: "t3", parent_tool_use_id: null, timestamp: 0 },
  { type: "tool_result", tool_use_id: "t3", output: "ok", is_error: false, timestamp: 0 },
  usage,
];

async function mountChat(page: Page, events: unknown[] = []): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
}

const streamed = () => {
  const t = turn();
  // Real live shape: a streaming text slot is open before the tool call and
  // the result line finalizes it afterwards.
  return [
    t[0],
    { type: "assistant_message", content: [{ type: "text", text: "" }], streaming: true, timestamp: 0 },
    ...t.slice(1, 7),
    { type: "assistant_message", content: [{ type: "text", text: "Done." }], streaming: false, timestamp: 0 },
    usage,
  ];
};

test.describe("view-harness / pr_preview tool call shows a visible card", () => {
  test("live stream with an open streaming slot finalized by the result line", async ({ page }) => {
    await mountChat(page);
    await page.waitForFunction((name) => {
      const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
      return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
    }, CHANNEL);
    await fireEvent(page, CHANNEL, streamed());
    const card = page.locator("#session-pane .session-messages .pr-preview-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
  });

  test("runner stream and file watcher both deliver the turn", async ({ page }) => {
    await mountChat(page);
    const watch = `chat-watch:${SESSION.session_id}`;
    await page.waitForFunction(([a, b]) => {
      const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
      return (w.__ccListeners?.get(a!)?.size ?? 0) > 0 && (w.__ccListeners?.get(b!)?.size ?? 0) > 0;
    }, [CHANNEL, watch]);
    const t = turn();
    const perLineUsage = { ...usage, duration_ms: 0 };
    await fireEvent(page, CHANNEL, t.slice(0, 3));
    await fireEvent(page, watch, [t[3], perLineUsage, t[4]]);
    await fireEvent(page, CHANNEL, t.slice(3));
    await fireEvent(page, watch, t.slice(5));
    const card = page.locator("#session-pane .session-messages .pr-preview-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
  });

  test("live stream", async ({ page }) => {
    await mountChat(page);
    await page.waitForFunction((name) => {
      const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
      return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
    }, CHANNEL);
    await fireEvent(page, CHANNEL, turn());
    const card = page.locator("#session-pane .session-messages .pr-preview-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
  });

  test("history reload", async ({ page }) => {
    await mountChat(page, turn());
    const card = page.locator("#session-pane .session-messages .pr-preview-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
  });
});
