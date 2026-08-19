import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// .sb-row scrolls horizontally by design (session-statusbar.css:34-36) but gave
// no cue that more chips sat off-screen - on a phone that read as a broken,
// clipped layout. sb-row-scroll (+ the -at-start/-at-end pair) drives a fade at
// whichever edge still has content, and must never show on a row that fits.

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
  set_session_effort: null,
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

const SESSIONS = [instance()];

// Many chips (mostly fixed-width skeletons) - guaranteed to outgrow a phone
// screen. Kept to git/session-section chips so no extra IPC seeding is needed.
const LONG_ROW = [
  "model", "effort", "context_pct", "context_tokens", "branch", "repo", "folder",
  "commits", "commits_ahead", "commits_behind", "dirty", "sha", "diffstat",
  "messages", "turns", "duration", "cost", "clock",
];
const SHORT_ROW = ["model", "effort", "duration"];

async function mountSessionRow(page: Page, row: string[]): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      // Both keys: these run at a phone viewport, which reads the mobile
      // profile, but the specs are about fade mechanics rather than defaults,
      // so they should pin the row whichever profile is live.
      get_settings: { theme: "void", statuslineRows: [row], statuslineRowsMobile: [row] },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
  await page.locator("#session-pane .sb-row").first().waitFor();
}

test.describe("view-harness / statusbar scroll fade", () => {
  test("overflowing row at a narrow (phone) viewport gets the edge fade", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await mountSessionRow(page, LONG_ROW);

    const row = page.locator("#session-pane .sb-row").first();
    const dims = await row.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);
    await expect(row).toHaveClass(/sb-row-scroll/);

    // At rest (scrollLeft 0): right fade shows, left fade is suppressed.
    const gradients = await row.evaluate((el) => ({
      before: getComputedStyle(el, "::before").backgroundImage,
      after: getComputedStyle(el, "::after").backgroundImage,
    }));
    expect(gradients.before).toBe("none");
    expect(gradients.after).not.toBe("none");

    // Scroll to the end: right fade disappears, left fade appears.
    await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(row).toHaveClass(/sb-row-at-end/);
    const atEnd = await row.evaluate((el) => ({
      before: getComputedStyle(el, "::before").backgroundImage,
      after: getComputedStyle(el, "::after").backgroundImage,
    }));
    expect(atEnd.before).not.toBe("none");
    expect(atEnd.after).toBe("none");
  });

  test("a row that fits at a wide viewport shows no fade", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountSessionRow(page, SHORT_ROW);

    const row = page.locator("#session-pane .sb-row").first();
    const dims = await row.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth);
    await expect(row).not.toHaveClass(/sb-row-scroll/);

    const gradients = await row.evaluate((el) => ({
      before: getComputedStyle(el, "::before").backgroundImage,
      after: getComputedStyle(el, "::after").backgroundImage,
    }));
    expect(gradients.before).toBe("none");
    expect(gradients.after).toBe("none");
  });

  // render() rebuilds .sb-row via innerHTML, which resets scrollLeft to 0 -
  // any live re-render (chip commit, meta update, popover) used to snap a
  // scrolled row back to the start.
  test("re-render preserves the row's horizontal scroll position", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await mountSessionRow(page, LONG_ROW);

    const row = page.locator("#session-pane .sb-row").first();
    await expect(row).toHaveClass(/sb-row-scroll/);
    const target = await row.evaluate((el) => {
      el.scrollLeft = 40;
      return el.scrollLeft;
    });
    expect(target).toBeGreaterThan(0);

    // Drive a real re-render through the effort popover's commit path (statusbar
    // owns this end-to-end, no chat renderer needed).
    await page.locator("#session-pane .sb-effort-btn").click();
    await page.locator(".sb-effort-slider").waitFor();
    await page.locator(".sb-effort-slider").evaluate((el: HTMLInputElement) => {
      el.value = "0";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await expect(page.locator("#session-pane .sb-effort-btn")).toHaveText(/low/i);
    await expect(row).toHaveClass(/sb-row-scroll/);
    await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBe(target);
  });
});
