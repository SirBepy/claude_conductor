// Reviewed 2026-11-12 (quotes as reply bubbles): renderMarkdown tags every blockquote .md-quote and lifts a leading **Name:** onto a speaker line, the transcript no longer wraps a quote in a copy card (.card-block is gone), and the draft editor's blockquote rule moved into the shared one; nothing this spec asserts changed, and it passes (chat-message-cards and subchat-passed fail their phone-width overflow tests on pristine HEAD too).
// Reviewed 2026-11-10: chat-dom-renderer.ts's flushRender also fires the renderer's onFlushed hook; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-05: renderMessage gained a "passed" row kind (the quiet "Passed to X" line); every other kind renders as before - this spec's contract is unchanged and it passes.
// Reviewed 2026-11-01: chat-dom-renderer.ts gained describeActivityFull for the working bar's label; the PR card path this spec drives is untouched and it passes.
// Reviewed 2026-10-30 (user-message attachment tray): chat-dom-renderer.ts now groups a USER message's attachment chips into a tray; this spec only asserts assistant /create-pr cards, so its contract is unchanged.
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, fireEvent } from "./harness";

// asserts: src/shared/chat/chat-dom-renderer.ts, src/shared/chat/chat-transforms.ts

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const MARKERS = `<cc-pr-title:Fix thing>\n<cc-pr-body:${b64("## Summary\n" + "x".repeat(7000))}>\n<cc-pr-commits:${b64(JSON.stringify([{ sha: "abc", msg: "m" }]))}>`;

async function mountChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const usage = {
  type: "turn_usage", input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, total_cost_usd: 0.001, duration_ms: 1200, has_thinking: false,
  model: null, awaiting: null, autopilot_changed: null,
};

test.describe("view-harness / /create-pr card is actually visible in quiet mode", () => {
  test("markers streamed after send_message + report_turn_status render a visible card", async ({ page }) => {
    await mountChat(page);
    await fireEvent(page, CHANNEL, [
      { type: "user_message", content: [{ type: "text", text: "/create-pr" }], timestamp: 0 },
      { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { text: "making the PR" }, id: "t1", timestamp: 0 },
      { type: "tool_use", tool_name: "mcp__cc_conductor__report_turn_status", input: { awaiting: "working" }, id: "t2", timestamp: 0 },
      { type: "assistant_message", content: [{ type: "text", text: "" }], streaming: true, timestamp: 0 },
      { type: "assistant_delta", text: MARKERS, block: 1, seq: 1, snapshot: false, timestamp: 0 },
      { type: "assistant_message", content: [{ type: "text", text: MARKERS }], streaming: false, timestamp: 0 },
      usage,
    ]);
    const card = page.locator("#session-pane .session-messages .pr-preview-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
  });

  test("a reload from history shows the card", async ({ page }) => {
    const events = [
      { type: "user_message", content: [{ type: "text", text: "/create-pr" }], timestamp: 0 },
      { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { text: "making the PR" }, id: "t1", timestamp: 0 },
      { type: "tool_use", tool_name: "mcp__cc_conductor__report_turn_status", input: { awaiting: "working" }, id: "t2", timestamp: 0 },
      { type: "assistant_message", content: [{ type: "text", text: MARKERS }], streaming: false, timestamp: 0 },
      usage,
    ];
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
    const card = page.locator("#session-pane .session-messages .pr-preview-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
  });

  test("markers streamed, then report_turn_status, ending on turn_usage alone", async ({ page }) => {
    await mountChat(page);
    await fireEvent(page, CHANNEL, [
      { type: "user_message", content: [{ type: "text", text: "/create-pr" }], timestamp: 0 },
      { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { text: "making the PR" }, id: "t1", timestamp: 0 },
      { type: "assistant_message", content: [{ type: "text", text: "" }], streaming: true, timestamp: 0 },
      { type: "assistant_delta", text: MARKERS, block: 1, seq: 1, snapshot: false, timestamp: 0 },
      { type: "tool_use", tool_name: "mcp__cc_conductor__report_turn_status", input: { awaiting: "working" }, id: "t2", timestamp: 0 },
      usage,
    ]);
    const card = page.locator("#session-pane .session-messages .pr-preview-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
  });
});
