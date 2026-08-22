import { expect, test } from "@playwright/test";
import { capture, mountView, sessionInstance } from "./harness";

// Todo 544: visual confirmation of quiet-mode chat (commit 9f4500b8).
// Narration rows must be present-but-hidden by default; the chat menu's
// "Show raw activity" flips .show-raw-chat on the live container.
const DESKTOP = { width: 1400, height: 900 };

const SESSION = sessionInstance();

function transcript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "Fix the pump timeout." }], timestamp: 0, remote_echo: false, is_meta: false },
    { type: "assistant_message", content: [{ type: "text", text: "Reading pump.rs to find the timeout constant before touching anything." }], streaming: false, timestamp: 0 },
    { type: "tool_use", tool_name: "Read", input: { file_path: "src-tauri/src/pump.rs" }, id: "t1", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "const TIMEOUT_MS: u64 = 5000;" }, is_error: false, timestamp: 0 },
    { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { text: "Pump timeout raised to 30s, tests green." }, id: "t2", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: "t2", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("quiet-mode chat: deliberate bubble only, then raw activity revealed", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, {
      view: "sessions",
      invoke: {
        get_accounts_setup_prompt_state: { shouldShow: false },
        get_usage_map: {}, get_skill_usage_week: { entries: [], total_sessions: 0 },
        poll_now: null, list_projects: [], resolve_whitelist_characters: [],
        probe_models_availability: [], list_accounts: [], list_scheduled_messages: [],
        list_session_characters: {}, watch_session_transcript: null,
        unwatch_session_transcript: null, session_live_cwd: null, get_git_info: null,
        get_session_counts: null, get_context_status: null, get_session_drain: null,
        list_pending_prompts: [], get_chat_config: null, list_previews: [],
        list_slash_commands: [],
        list_instances: [SESSION], get_active_sessions: [SESSION],
        load_history_page: transcript(),
      },
    });
    await page.locator(`#sessions-list li[data-session-id='${SESSION.session_id}']`).click();

    const messages = page.locator("#session-pane .session-messages");
    // The send_message bubble reuses .msg.assistant markup; what separates it
    // from narration is the absence of .chat-narration.
    const deliberate = messages.locator(".msg.assistant:not(.chat-narration)");
    const narration = messages.locator(".chat-narration");

    await expect(deliberate).toHaveCount(1);
    await expect(deliberate).toBeVisible();
    await expect(deliberate).toContainText("Pump timeout raised to 30s");

    // The point of the shot: narration is in the DOM, just not painted.
    expect(await narration.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await narration.count()); i++) {
      await expect(narration.nth(i)).toBeHidden();
    }
    await expect(messages).not.toHaveClass(/show-raw-chat/);
    await capture(messages, "quiet-mode-default");

    // Real toggle path: viewMore kebab -> THIS CHAT -> Chat -> Show raw activity.
    await page.locator("#viewMoreBtn").click();
    await page.locator('.smore-item[data-sub-label="Chat"]').click();
    const item = page.locator(".chat-menu-submenu .smore-item", { hasText: "Show raw activity" }).first();
    await expect(item).toBeVisible();
    await item.click();

    await expect(messages).toHaveClass(/show-raw-chat/);
    await expect(narration.first()).toBeVisible();
    await expect(messages).toContainText("Reading pump.rs");
    await expect(deliberate).toBeVisible();
    await capture(messages, "quiet-mode-raw-toggle");
  });
});
