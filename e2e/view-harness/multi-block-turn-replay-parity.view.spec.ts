import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, fireEvent } from "./harness";

// Todo 858: pins that a same-turn text/tool_use/text turn renders the SAME
// bubble count live and on history replay. parser/mod.rs already splits
// replay to match live (group-per-text-block); this spec guards the DOM
// render layer, which no prior test covered.

const LIVE_SESSION = sessionInstance({ session_id: "live-1" });
const REPLAY_SESSION = sessionInstance({ session_id: "replay-1" });
const LIVE_CHANNEL = `chat:${LIVE_SESSION.session_id}`;

const BLOCK_ONE_TEXT = "Checking the config now.";
const BLOCK_TWO_TEXT = "Found it.";

function toolUsePair(id: string): unknown[] {
  return [
    { type: "tool_use", tool_name: "Grep", input: { pattern: "timeout" }, id, timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: id, output: { type: "text", text: "3 matches" }, is_error: false, timestamp: 0 },
  ];
}

async function mountLive(page: Page): Promise<void> {
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

async function mountReplay(page: Page): Promise<void> {
  const events: unknown[] = [
    { type: "assistant_message", content: [{ type: "text", text: BLOCK_ONE_TEXT }], streaming: false, timestamp: 0 },
    ...toolUsePair("tu1"),
    { type: "assistant_message", content: [{ type: "text", text: BLOCK_TWO_TEXT }], streaming: false, timestamp: 0 },
  ];
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [REPLAY_SESSION],
      get_active_sessions: [REPLAY_SESSION],
      load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${REPLAY_SESSION.session_id}"]`).click();
  // Raw narration (plain assistant prose) is CSS-hidden in quiet mode by
  // default, so wait for DOM attachment, not visibility.
  await page.locator("#session-pane .session-messages .msg.assistant:not(.streaming)").first().waitFor({ state: "attached" });
}

// One page per path (not one page reused across two mountView navigations) -
// addInitScript stacks across navigations on a shared page, which let a
// stale mock leak into the second mount. Parity is asserted by both tests
// independently pinning the SAME bubble count and text order.

test("live: a same-turn text/tool_use/text sequence renders two assistant bubbles", async ({ page }) => {
  await mountLive(page);

  await fireEvent(page, LIVE_CHANNEL, [
    { type: "assistant_delta", text: BLOCK_ONE_TEXT, block: 1, seq: 1, snapshot: false, timestamp: 0 },
    ...toolUsePair("tu1"),
    { type: "assistant_delta", text: BLOCK_TWO_TEXT, block: 2, seq: 1, snapshot: false, timestamp: 0 },
    {
      type: "turn_usage",
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: 0.001,
      duration_ms: 1200,
      has_thinking: false,
      model: null,
      awaiting: null,
      autopilot_changed: null,
    },
  ]);

  const liveBubbles = page.locator("#session-pane .session-messages .msg.assistant:not(.streaming)");
  await expect(liveBubbles).toHaveCount(2);
  await expect(liveBubbles.nth(0)).toContainText(BLOCK_ONE_TEXT);
  await expect(liveBubbles.nth(1)).toContainText(BLOCK_TWO_TEXT);
});

test("replay: the equivalent history events render the same two assistant bubbles", async ({ page }) => {
  await mountReplay(page);

  const replayBubbles = page.locator("#session-pane .session-messages .msg.assistant:not(.streaming)");
  await expect(replayBubbles).toHaveCount(2);
  await expect(replayBubbles.nth(0)).toContainText(BLOCK_ONE_TEXT);
  await expect(replayBubbles.nth(1)).toContainText(BLOCK_TWO_TEXT);
});
