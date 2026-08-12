import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Regression: 2 of 6 picks vanished on a sidebar session switch. Drives the
// real sidebar and selectSession, not the save/restore helpers in isolation,
// so a break anywhere in the mount/teardown path shows up.

declare global {
  interface Window {
    __questionModule?: typeof import("/views/sessions/permission-modal/index.ts");
  }
}

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

const SIX_QUESTIONS = Array.from({ length: 6 }, (_, i) => ({
  question: `Question ${i + 1}?`,
  options: [{ label: "Yes" }, { label: "No" }],
}));

async function mountSessions(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.locator(`#sessions-list li[data-session-id="${sessionId}"]`).click();
  await page.locator("#session-pane .session-composer").waitFor();
}

test.describe("view-harness / AUQ card draft survives a real sidebar session switch", () => {
  test("2 of 6 answers picked, click another session, click back - picks remain", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");

    await page.evaluate(async (questions) => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      window.__questionModule = qm;
      qm.handleQuestionRequested({ id: "q-a-1", session_id: "s1", questions });
    }, SIX_QUESTIONS);

    const card = page.locator(".prompt-card");
    await expect(card).toHaveCount(1);

    await card.locator('.prompt-panel[data-panel="0"] input[data-label="Yes"]').click();
    await card.locator('.prompt-panel[data-panel="1"] input[data-label="Yes"]').click();
    await expect(card.locator('.prompt-panel[data-panel="0"] input[data-label="Yes"]')).toBeChecked();
    await expect(card.locator('.prompt-panel[data-panel="1"] input[data-label="Yes"]')).toBeChecked();

    await openChat(page, "s2");
    await expect(page.locator(".prompt-card")).toHaveCount(0);

    await openChat(page, "s1");
    const restoredCard = page.locator(".prompt-card");
    await expect(restoredCard).toHaveCount(1);
    await expect(restoredCard.locator('.prompt-panel[data-panel="0"] input[data-label="Yes"]')).toBeChecked();
    await expect(restoredCard.locator('.prompt-panel[data-panel="1"] input[data-label="Yes"]')).toBeChecked();
  });
});
