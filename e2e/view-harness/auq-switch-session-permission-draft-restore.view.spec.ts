import { test, expect, type Page } from "@playwright/test";
import { mountView, openAnswerBar } from "./harness";

// c306a4b4: savePendingPromptDraft (gating.ts) used to only attach a draft to
// a parked "question"-kind prompt, silently dropping a "permission"-kind
// (fallback card) draft on a chat switch. Covers that branch via the real
// sidebar switch - see auq-switch-session-draft-restore.spec's "question" one.

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
  respond_permission: null,
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

const PERMISSION_QUESTION_INPUT = {
  questions: [{ question: "Which deploy target?", options: [{ label: "Prod" }, { label: "Staging" }] }],
};

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

test.describe("view-harness / fallback (permission-kind) AUQ draft survives a real sidebar session switch", () => {
  test("typed free text in the fallback card survives switch-away and back", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");

    await page.evaluate(async (input) => {
      const mod = await import("/views/sessions/permission-modal/permission-card.ts");
      mod.showPermissionCard({ id: "perm-switch-1", tool_name: "Bash", session_id: "s1", input });
    }, PERMISSION_QUESTION_INPUT);

    const card = page.locator(".prompt-card");
    await expect(card).toHaveCount(1);

    await openAnswerBar(card);
    const ownInput = card.locator(".prompt-q__other-input");
    await ownInput.fill("Prod, but confirm with the team first");
    await expect(ownInput).toHaveValue("Prod, but confirm with the team first");

    await openChat(page, "s2");
    await expect(page.locator(".prompt-card")).toHaveCount(0);

    await openChat(page, "s1");
    const restoredCard = page.locator(".prompt-card");
    await expect(restoredCard).toHaveCount(1);
    const restoredInput = restoredCard.locator(".prompt-q__other-input");
    await expect(restoredInput).toHaveValue("Prod, but confirm with the team first");

    await restoredCard.screenshot({
      path: ".for_bepy/screenshots/_specs/auq-permission-draft-restore.png",
    });
  });
});
