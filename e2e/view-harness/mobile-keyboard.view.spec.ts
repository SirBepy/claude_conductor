import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Soft-keyboard chrome-unmount (Joe's ask, 2026-08-20): visualViewport
// shrinking simulates the keyboard opening - no real IME in headless Chrome,
// but a viewport resize drives window.visualViewport identically to what an
// on-screen keyboard does, which is the only signal mobile-keyboard.ts reads.

const PHONE = { width: 393, height: 852 };
const KEYBOARD_HEIGHT = 400; // shrinks the viewport well past the 150px open threshold

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

const SESSION = {
  session_id: "s1", pid: 100, cwd: "C:/Projects/alpha",
  project_id: "p1", kind: "interactive", is_remote: false,
  started_at: "2026-08-01T10:00:00Z", transcript_path: null, bridge_session_id: null,
  name: "Alpha chat", ended_at: null, end_reason: null,
  busy: false, model: "claude-opus-5", effort: "high", awaiting: "done",
  autopilot: false, jarvis: false, worker_of: null, closing: false,
  account_id: null, rate_limited_resets_at: null, rate_limited_type: null,
};

async function mountPhoneSession(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
}

test.describe("view-harness / mobile keyboard chrome-unmount", () => {
  test("shrinking the viewport (keyboard open) hides the header/statusbar/tab bar", async ({ page }) => {
    await mountPhoneSession(page);
    await expect(page.locator(".session-header")).toBeVisible();
    await expect(page.locator(".mobile-tabbar")).toBeVisible();

    await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD_HEIGHT });
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-keyboard", "");
    await expect(page.locator(".session-header")).toBeHidden();
    await expect(page.locator(".session-statusbar")).toBeHidden();
    await expect(page.locator(".mobile-tabbar")).toBeHidden();
  });

  test("restoring the viewport (keyboard closed) brings the chrome back", async ({ page }) => {
    await mountPhoneSession(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD_HEIGHT });
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-keyboard", "");

    await page.setViewportSize(PHONE);
    await expect(page.locator(".view-sessions")).not.toHaveAttribute("data-mobile-keyboard", "");
    await expect(page.locator(".session-header")).toBeVisible();
    await expect(page.locator(".mobile-tabbar")).toBeVisible();
  });

  test("desktop width never sets the keyboard attribute", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...BASE_INVOKE,
        list_instances: [SESSION],
        get_active_sessions: [SESSION],
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      },
    });
    await page.locator("#sessions-list li[data-session-id]").first().click();
    await page.locator("#session-pane .session-composer").waitFor();

    await page.setViewportSize({ width: 1280, height: 400 });
    await expect(page.locator(".view-sessions")).not.toHaveAttribute("data-mobile-keyboard", "");
  });
});
