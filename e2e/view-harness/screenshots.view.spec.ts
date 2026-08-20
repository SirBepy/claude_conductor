import { expect, test } from "@playwright/test";
import { capture, mountSessionsLayout, mountView } from "./harness";

// Capture-only: these assert nothing, they write PNGs into
// .for_bepy/screenshots/<session-id>/. CC_SHOTS is the gate, not --grep, which
// never reaches the worker process (measured 2026-08-20):
//   $env:CC_SHOTS=1; pnpm exec playwright test --grep '@shot' --workers=1
const DESKTOP = { width: 1400, height: 900 };
const PHONE = { width: 390, height: 780 };

const DASHBOARD_MOCKS = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_accounts: [
    { id: "acc-1", label: "Personal", icon: "user", colour: "#8b5cf6" },
    { id: "acc-2", label: "Work", icon: "briefcase", colour: "#57b894" },
  ],
  get_usage_map: {},
  get_auth_state_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  list_instances: [],
  poll_now: null,
};

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("dashboard", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { view: "dashboard", invoke: DASHBOARD_MOCKS });
    await capture(page, "dashboard");
  });

  test("sessions desktop, preview panel docked open", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: { list_previews: [] } });
    // No scaffold header here: it would paint over the booted shell's own band.
    await mountSessionsLayout(page, { openPanel: true });
    await capture(page, "sessions-desktop-panel");
  });

  test("sessions phone pager", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page, { invoke: { list_previews: [] } });
    await mountSessionsLayout(page, { pager: true });
    await capture(page, "sessions-phone-chat");

    await page.locator('.mtab[data-target="preview"]').click();
    // The pager scroll-snaps over a frame or two, so shooting straight after the
    // click still lands on the chat page.
    await expect
      .poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".sessions-layout")!.scrollLeft))
      .toBeGreaterThan(PHONE.width / 2);
    await capture(page, "sessions-phone-preview");
  });

  test("phone composer, full-bleed at the viewport edge", async ({ page }) => {
    // Shoots the surface todos 700/704 changed: .composer-shell's mobile margin.
    // Mounts a real session so the composer geometry comes from the real cascade.
    const session = {
      session_id: "s1", pid: 100, cwd: "C:/Projects/alpha", project_id: "p1",
      kind: "interactive", is_remote: false, started_at: "2026-08-01T10:00:00Z",
      transcript_path: null, bridge_session_id: null, name: "Alpha chat",
      ended_at: null, end_reason: null, busy: false, model: "claude-opus-5",
      effort: "high", awaiting: "done", autopilot: false, jarvis: false,
      worker_of: null, closing: false, account_id: null,
      rate_limited_resets_at: null, rate_limited_type: null,
    };
    await page.setViewportSize({ width: 393, height: 852 });
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
        list_pending_prompts: [], get_chat_config: null,
        list_instances: [session], get_active_sessions: [session],
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      },
    });
    await page.locator("#sessions-list li[data-session-id='s1']").click();
    await page.locator("#session-pane .session-composer").waitFor();
    await capture(page, "phone-composer-full-bleed");
  });

  test("overlay strip", async ({ page }) => {
    const now = Date.now();
    await mountView(page, {
      entry: "overlay",
      invoke: {
        list_accounts: [{ id: "acc1", label: "Fleet-3", colour: "#57b894", icon: "robot" }],
        get_usage_map: {
          acc1: {
            captured_at: new Date(now).toISOString(),
            five_hour: { utilization: 62, resets_at: new Date(now + 90 * 60_000).toISOString() },
            seven_day: { utilization: 41, resets_at: new Date(now + 4 * 24 * 3_600_000).toISOString() },
          },
        },
      },
    });
    await capture(page.locator("#ocPanel"), "overlay-strip");
  });
});
