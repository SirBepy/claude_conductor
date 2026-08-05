import { test, expect } from "@playwright/test";
import { mountView, invokeCalls } from "./harness";

// cd7da6c1 regression test: native confirm() never blocks under Tauri, so the
// destructive clear-context action fired regardless of the answer. Covers
// both the decline (never invokes) and accept (invokes once, pane re-mounts)
// paths through the real askConfirm overlay.

const JARVIS_OLD = {
  session_id: "jarvis-old", pid: 111, cwd: "C:/data/jarvis-home", project_id: "jarvis-home",
  kind: "interactive", is_remote: false, started_at: "2026-08-05T10:00:00Z",
  transcript_path: null, bridge_session_id: null, name: "Jarvis Old", ended_at: null,
  end_reason: null, busy: false, model: "sonnet", effort: "high", awaiting: null,
  autopilot: false, jarvis: true, worker_of: null, closing: false, account_id: null,
  rate_limited_resets_at: null, rate_limited_type: null,
};
// Both instances are seeded up front (not swapped in dynamically) since
// state.sessions is only refreshed once at mount - the post-clear remount
// looks the new id up in that same list.
const JARVIS_NEW = { ...JARVIS_OLD, session_id: "jarvis-new", name: "Jarvis New" };

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
  get_active_sessions: [],
  schedule_delete: null,
  schedule_list: [],
  load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
  list_instances: [JARVIS_OLD, JARVIS_NEW],
  clear_jarvis_context: "jarvis-new",
};

async function openClearContextConfirm(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, { view: "detached?session=jarvis-old", invoke: BASE_INVOKE });
  await page.locator(".jarvis-kebab-btn").click();
  await page.locator(".smore-item", { hasText: "Clear context" }).click();
  await page.locator(".app-confirm-overlay").waitFor();
}

test.describe("view-harness / Jarvis clear-context confirmation", () => {
  test("declining the confirm never invokes clear-context", async ({ page }) => {
    await openClearContextConfirm(page);
    await page.locator(".app-confirm-cancel").click();

    const calls = await invokeCalls(page);
    expect(calls.some((c) => c.cmd === "clear_jarvis_context")).toBe(false);
    await expect(page.locator(".session-header .title")).toHaveText("Jarvis Old");
  });

  test("accepting the confirm invokes clear-context once and re-mounts the pane", async ({ page }) => {
    await openClearContextConfirm(page);
    await page.locator(".app-confirm-ok").click();

    await expect(page.locator(".session-header .title")).toHaveText("Jarvis New");
    const calls = await invokeCalls(page);
    const clears = calls.filter((c) => c.cmd === "clear_jarvis_context");
    expect(clears).toEqual([{ cmd: "clear_jarvis_context", args: { sessionId: "jarvis-old" } }]);
  });
});
