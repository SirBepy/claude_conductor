import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Held-message cross-surface visibility (the "message waiting" ask): a row
// must show its held_count without the session being the open chat. Mirrors
// sidebar-row-style.view.spec.ts's mounting pattern.

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
  list_pending_prompts: [],
};

function instance(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "s1", pid: 100, cwd: "C:/Projects/claude_usage_in_taskbar",
    project_id: "p1", kind: "interactive", is_remote: false,
    started_at: "2026-07-30T10:00:00Z", transcript_path: null, bridge_session_id: null,
    name: "Held badge session", ended_at: null, end_reason: null,
    busy: false, model: "claude-opus-5", effort: "high", awaiting: "done",
    autopilot: false, jarvis: false, worker_of: null, closing: false,
    account_id: null, rate_limited_resets_at: null, rate_limited_type: null,
    held_count: 0,
    ...over,
  };
}

// The harness's own default (unset localStorage) resolves to "portrait"
// (row-style.ts), so every test pins its style explicitly rather than
// relying on that default - same convention sidebar-row-style.view.spec.ts
// uses.
async function mountSessions(
  page: import("@playwright/test").Page,
  sessions: Record<string, unknown>[],
  rowStyle: "classic" | "portrait" = "classic",
): Promise<void> {
  await page.addInitScript((v) => localStorage.setItem("cc_chat_row_style", v), rowStyle);
  await mountView(page, {
    view: "sessions",
    invoke: { ...BASE_INVOKE, list_instances: sessions, get_active_sessions: sessions },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

test.describe("view-harness / sidebar held-message badge", () => {
  test("shows the queued count on a backgrounded session, none on an idle one", async ({ page }) => {
    const sessions = [
      instance({ held_count: 2 }),
      instance({ session_id: "s2", cwd: "C:/Projects/zng-app", name: "No held messages" }),
    ];
    await mountSessions(page, sessions);

    await expect(page.locator('li[data-session-id="s1"] .session-held-badge')).toBeVisible();
    await expect(page.locator('li[data-session-id="s1"] .session-held-count')).toHaveText("2");
    await expect(page.locator('li[data-session-id="s2"] .session-held-badge')).toHaveCount(0);
  });

  test("a single queued message still shows the number, not just a dot", async ({ page }) => {
    await mountSessions(page, [instance({ held_count: 1 })]);
    await expect(page.locator('li[data-session-id="s1"] .session-held-count')).toHaveText("1");
  });

  test("held badge coexists with the attention badge without hiding either", async ({ page }) => {
    await mountSessions(page, [instance({ held_count: 3 })]);
    const row = page.locator('li[data-session-id="s1"]');
    // Simulate the parked-prompt attention state the same way
    // sidebar-row-style.view.spec.ts does - pendingPromptSessionIds is
    // module-internal state, not reachable through a mocked IPC call.
    await row.evaluate((li) => li.classList.add("needs-attention"));

    await expect(row).toHaveClass(/needs-attention/);
    await expect(row.locator(".session-held-badge")).toBeVisible();
    await expect(row.locator(".session-held-count")).toHaveText("3");
  });

  test("portrait row shows the held corner badge on the avatar", async ({ page }) => {
    await mountSessions(page, [instance({ held_count: 4 })], "portrait");
    const row = page.locator('li[data-session-id="s1"]');
    await expect(row).toHaveClass(/row-portrait/);
    await expect(row.locator(".session-held-corner")).toBeVisible();
    await expect(row.locator(".session-held-corner .session-held-count")).toHaveText("4");
  });
});
