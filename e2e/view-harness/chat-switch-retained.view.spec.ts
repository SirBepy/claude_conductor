import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Switching chats used to throw the transcript DOM away and rebuild it from the
// already-cached events: replay through the render state machine, re-highlight
// every code block, then a fade-in hold. These drive the real sidebar and assert
// on node identity - a rebuild that happens to look identical still fails.

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

const SESSIONS = [
  instance(),
  instance({ session_id: "s2", cwd: "C:/Projects/beta", project_id: "p2", name: "Beta chat" }),
];

// Enough turns (with fenced code, the expensive part) that a rebuild would be
// visible in both node identity and wall-clock.
function transcript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [];
  for (let i = 0; i < 10; i++) {
    events.push({ type: "user_message", content: [{ type: "text", text: `ask ${i}` }], timestamp: 0 });
    events.push({
      type: "assistant_message",
      content: [{ type: "text", text: `reply ${i}\n\n\`\`\`ts\nconst x${i}: number = ${i};\n\`\`\`` }],
      streaming: false,
      timestamp: 0,
    });
  }
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.locator(`#sessions-list li[data-session-id="${sessionId}"]`).click();
  await page.locator("#session-pane .session-messages .msg").first().waitFor();
}

/** A cold open keeps working after the first message paints: shiki replaces
 *  each fence, then the load re-pins to the bottom. Scrolling before that lands
 *  gets undone, so settle first. */
async function openChatSettled(page: Page, sessionId: string): Promise<void> {
  await openChat(page, sessionId);
  await page.waitForFunction(() => {
    const el = document.querySelector("#session-pane .session-messages") as HTMLElement | null;
    if (!el) return false;
    const w = window as unknown as { __lastH?: number; __stable?: number };
    if (w.__lastH === el.scrollHeight) w.__stable = (w.__stable ?? 0) + 1;
    else w.__stable = 0;
    w.__lastH = el.scrollHeight;
    return (w.__stable ?? 0) >= 12;
  }, undefined, { polling: 50 });
  await page.evaluate(() => {
    const w = window as unknown as { __lastH?: number; __stable?: number };
    w.__lastH = undefined;
    w.__stable = 0;
  });
}

async function mountSessions(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      load_history_page: transcript(),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

test.describe("view-harness / chat switching reuses the rendered transcript", () => {
  test("switching back returns the SAME transcript node, not a rebuild", async ({ page }) => {
    await mountSessions(page);

    await openChat(page, "s1");
    // Brand the live element + its first message so a rebuild is detectable.
    await page.evaluate(() => {
      const el = document.querySelector("#session-pane .session-messages")!;
      (el as HTMLElement).dataset.brand = "alpha";
      el.querySelector(".msg")!.setAttribute("data-brand-msg", "alpha");
    });

    await openChat(page, "s2");
    // The other chat gets its own element - the brand must NOT follow it.
    await expect(page.locator("#session-pane .session-messages")).not.toHaveAttribute("data-brand", "alpha");

    await openChat(page, "s1");
    await expect(page.locator("#session-pane .session-messages")).toHaveAttribute("data-brand", "alpha");
    await expect(page.locator("#session-pane .session-messages .msg[data-brand-msg='alpha']")).toHaveCount(1);
  });

  test("reselecting a chat lands at the bottom, not wherever the reader left it", async ({ page }) => {
    await mountSessions(page);
    await openChatSettled(page, "s1");
    const parked = await page.locator("#session-pane .session-messages").evaluate((el) => {
      el.scrollTop = 0;
      return el.scrollTop;
    });
    expect(parked).toBe(0);

    await openChatSettled(page, "s2");
    await openChatSettled(page, "s1");
    // edbb0f67 (FIX) reverted scroll-position restore: reselecting a retained
    // chat re-pins toward the bottom, same as a cold load, instead of coming
    // back where the reader left it. Tolerance matches chat-scroll.ts's own
    // SCROLL_BOTTOM_THRESHOLD (64px) - the app's definition of "at the bottom".
    const restored = await page.locator("#session-pane .session-messages").evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }));
    expect(restored.max).toBeGreaterThan(0);
    expect(restored.max - restored.top).toBeLessThanOrEqual(64);
  });

  test("the transcript never blanks out on the way back in", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");
    await openChat(page, "s2");

    // The cold path holds the transcript at opacity 0 while it assembles. A
    // retained pane must be painted the moment it is back in the document.
    await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
    const opacity = await page.locator("#session-pane .session-messages").evaluate(
      (el) => getComputedStyle(el).opacity,
    );
    expect(Number(opacity)).toBe(1);
  });
});
