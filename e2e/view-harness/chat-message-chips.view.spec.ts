import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Todo 586 follow-up / commit 205b00d0: the meta-turn chips, the retracted
// placeholder and the interrupted-turn dim, rendered through the real
// chat-messages.css cascade rather than asserted as HTML strings.
//
// Meta chips moved inline into the tool-strip (ensureMetaChip, turn-chips.ts)
// - the old `.meta-chip` row is now CSS-hidden bookkeeping only, so this test
// drives the real live pipeline (sessions view + load_history_page) instead.

const SHOTS = ".for_bepy/screenshots/31948-639219629330654291";

const ROWS = [
  { kind: "message", text: "Pushed 3 commits, tests green.", ts: 0 },
  { kind: "message", text: "Committing now.", dimmed: true, ts: 0 },
  { kind: "message", text: "tests failing", retracted: true, ts: 0 },
];

async function mountChat(page) {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async (rows) => {
    await import("/views/sessions/sessions.ts");
    const { renderMessage } = await import("/shared/chat/chat-transforms.ts");
    const host = document.createElement("div");
    host.id = "chip-harness";
    host.className = "chat-messages";
    host.style.cssText = "padding:16px;max-width:720px";
    host.innerHTML = rows.map((m) => renderMessage(m)).join("");
    document.body.replaceChildren(host);
  }, ROWS);
  return page.locator("#chip-harness");
}

// ---------------------------------------------------------------------------
// Meta-turn chips: real pipeline (turn footer/tool-strip), not a raw mount.
// ---------------------------------------------------------------------------

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
    busy: false, model: "claude-opus-5", effort: "high", awaiting: "done",
    autopilot: false, jarvis: false, worker_of: null, closing: false,
    account_id: null, rate_limited_resets_at: null, rate_limited_type: null,
    ...over,
  };
}

// Peer/fleet each close with a send_message bubble (the only thing besides
// raw narration - gated off by default - that counts as "visible", so the
// next meta turn won't streak-merge). Wake fires 3x with nothing between,
// letting the real merge collapse them into one chip with streakCount 3.
function sendMessagePair(id: string, text: string): unknown[] {
  return [
    { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { text }, id, timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: id, output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
  ];
}

function metaTranscript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "[repo-channel] session-b: heads up, touching pump.rs" }], timestamp: 0, remote_echo: false, is_meta: true },
    ...sendMessagePair("tu1", "noted"),
    { type: "user_message", content: [{ type: "text", text: "[fleet] worker \"apk\" blocked on prompt 12" }], timestamp: 0, remote_echo: false, is_meta: true },
    ...sendMessagePair("tu2", "ack"),
    { type: "user_message", content: [{ type: "text", text: "Check the research agent." }], timestamp: 0, remote_echo: false, is_meta: true },
    { type: "user_message", content: [{ type: "text", text: "Check the research agent." }], timestamp: 0, remote_echo: false, is_meta: true },
    { type: "user_message", content: [{ type: "text", text: "Check the research agent." }], timestamp: 0, remote_echo: false, is_meta: true },
    ...sendMessagePair("tu3", "done"),
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountMetaChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...BASE_INVOKE,
      list_instances: [instance()],
      get_active_sessions: [instance()],
      load_history_page: metaTranscript(),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-messages .tool-chip--meta").first().waitFor();
}

test("meta-turn chips render inline in the turn strip, one per source, payload not inline", async ({ page }) => {
  await mountMetaChat(page);

  const chips = page.locator("#session-pane .session-messages .tool-chip--meta");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toHaveClass(/tool-chip--meta-peer/);
  await expect(chips.nth(0)).toHaveText(/Peer message/);
  await expect(chips.nth(1)).toHaveClass(/tool-chip--meta-fleet/);
  await expect(chips.nth(1)).toHaveText(/Fleet update/);
  await expect(chips.nth(2)).toHaveClass(/tool-chip--meta-wake/);
  await expect(chips.nth(2)).toHaveText(/Scheduled wake.*3/);

  // The wall-of-text this replaced: no chip may be wider than its own row.
  for (let i = 0; i < 3; i++) {
    const box = (await chips.nth(i).boundingBox())!;
    expect(box.height).toBeGreaterThan(14);
    expect(box.height).toBeLessThan(40);
    expect(box.width).toBeLessThan(320);
  }

  // Payload rides the tooltip only.
  await expect(chips.nth(0)).toHaveAttribute("title", /repo-channel/);
  await expect(chips.nth(0)).not.toHaveText(/pump\.rs/);
});

test("a retracted message collapses to a struck pill, not a bubble", async ({ page }) => {
  const host = await mountChat(page);

  const chip = host.locator(".retracted-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/Retracted/);
  await expect(chip).toHaveCSS("text-decoration-line", "line-through");

  // Must be visually smaller than the real bubble it replaced.
  const chipBox = (await chip.boundingBox())!;
  const bubbleBox = (await host.locator(".msg.assistant").first().boundingBox())!;
  expect(chipBox.width).toBeLessThan(bubbleBox.width);
});

test("an interrupted-turn bubble is dimmed but still readable", async ({ page }) => {
  const host = await mountChat(page);

  const dimmed = host.locator(".msg.assistant.dimmed");
  await expect(dimmed).toHaveCount(1);
  await expect(dimmed).toHaveText(/Committing now/);
  await expect(dimmed).toHaveCSS("opacity", "0.5");
  await expect(dimmed).toHaveCSS("font-style", "italic");

  // Still legible: dimmed, not hidden or collapsed.
  const box = (await dimmed.boundingBox())!;
  expect(box.height).toBeGreaterThan(14);

  await host.screenshot({ path: `${SHOTS}/chat-message-chips.png` });
});
