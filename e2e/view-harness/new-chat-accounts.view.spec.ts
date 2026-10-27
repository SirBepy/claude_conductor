// asserts: src/views/sessions/new-chat-config.ts, src/views/sessions/pending-pane-composer.ts, src/views/sessions/account-picker-logic.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, invokeCalls, SESSIONS_BASE_INVOKE } from "./harness";

// There is no new-chat dialog: every entry point opens the draft chat pane
// directly, on account = project binding > default account > none. The draft's
// statusbar chip shows the resolved account; with accounts registered but none
// resolved, the FIRST SEND is refused with a toast and the account picker
// opens (pending-pane-composer.ts). Frontend half of the mobile account-sharing
// fix (ai_todo 241): list_accounts must feed the draft or the picker is empty.

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
};
const WORK = { id: "acc1", label: "work", icon: "briefcase", colour: "#8b5cf6" };
const HOME = { id: "acc2", label: "home", icon: "house", colour: "#10b981" };

async function openDraft(page: Page, extra: Record<string, unknown>): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [], get_active_sessions: [],
      list_project_groups: [PROJECT], list_projects: [],
      resolve_project_account: null, project_last_activity_at: 0, count_ai_todos: 0,
      list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
      get_history: [],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      ...extra,
    },
  });
  await page.locator("#viewMoreBtn").waitFor();
  await page.keyboard.press("Control+n");
  await page.locator(".project-picker-row").click();
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
}

test.describe("view-harness / new-chat account resolution in the draft", () => {
  test("default account is preselected: the draft's account chip names it", async ({ page }) => {
    await openDraft(page, {
      list_accounts: [WORK, HOME],
      get_settings: { theme: "void", default_account_id: "acc2" },
    });
    await expect(page.locator("#session-pane .sb-account")).toHaveAttribute("aria-label", "Home");
  });

  test("project binding beats the default account", async ({ page }) => {
    await openDraft(page, {
      list_accounts: [WORK, HOME],
      get_settings: { theme: "void", default_account_id: "acc2" },
      resolve_project_account: "acc1",
    });
    await expect(page.locator("#session-pane .sb-account")).toHaveAttribute("aria-label", "Work");
  });

  test("no default and two accounts: first send is refused with a toast and opens the account picker", async ({ page }) => {
    await openDraft(page, { list_accounts: [WORK, HOME] });
    await expect(page.locator("#session-pane .sb-account")).toHaveCount(0);

    const ta = page.locator("#session-pane .session-composer .composer-textarea");
    await ta.fill("hello");
    await ta.press("Enter");

    await expect(page.getByText("Pick an account for this chat first")).toBeVisible();
    const modal = page.locator(".cam-modal-card");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".account-chip")).toHaveCount(2);
    await expect(modal.locator(".account-chip.sel")).toHaveCount(0);
    // The refused text goes back into the composer.
    await expect(ta).toHaveValue("hello");
  });

  test("no default and two accounts: scheduling is refused, opens the picker, keeps the text and creates nothing", async ({ page }) => {
    await openDraft(page, { list_accounts: [WORK, HOME], schedule_create: { fire_at: new Date().toISOString() } });

    const ta = page.locator("#session-pane .session-composer .composer-textarea");
    await ta.fill("hello later");
    await page.locator("#session-pane .composer-send-chevron").click();
    await page.getByRole("button", { name: "Schedule message" }).click();
    await page.locator(".schedule-picker-popover [data-preset]").first().click();

    await expect(page.getByText("Pick an account for this chat first")).toBeVisible();
    await expect(page.locator(".cam-modal-card")).toBeVisible();
    await expect(ta).toHaveValue("hello later");
    await expect(page.locator("#session-pane .composer-notice")).toBeHidden();
    expect((await invokeCalls(page)).filter((c) => c.cmd === "schedule_create")).toHaveLength(0);
  });

  test("no accounts registered: first send says to add one in Settings, keeps the text and spawns nothing", async ({ page }) => {
    await openDraft(page, { list_accounts: [], start_session: "sess-1" });

    const ta = page.locator("#session-pane .session-composer .composer-textarea");
    await ta.fill("hello");
    await ta.press("Enter");

    await expect(page.getByText("Add an account in Settings first")).toBeVisible();
    await expect(page.locator(".cam-modal-card")).toHaveCount(0);
    await expect(ta).toHaveValue("hello");
    expect((await invokeCalls(page)).filter((c) => c.cmd === "start_session")).toHaveLength(0);
  });

  test("no accounts registered: scheduling says to add one in Settings, keeps the text and creates nothing", async ({ page }) => {
    await openDraft(page, { list_accounts: [], schedule_create: { fire_at: new Date().toISOString() } });

    const ta = page.locator("#session-pane .session-composer .composer-textarea");
    await ta.fill("hello later");
    await page.locator("#session-pane .composer-send-chevron").click();
    await page.getByRole("button", { name: "Schedule message" }).click();
    await page.locator(".schedule-picker-popover [data-preset]").first().click();

    await expect(page.getByText("Add an account in Settings first")).toBeVisible();
    await expect(ta).toHaveValue("hello later");
    await expect(page.locator("#session-pane .composer-notice")).toBeHidden();
    expect((await invokeCalls(page)).filter((c) => c.cmd === "schedule_create")).toHaveLength(0);
  });
});
