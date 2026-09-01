import { expect, test, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Todo 834: mechanizes the one remaining acceptance item, "with each of the
// ten modals open, typing plain characters leaves the composer unchanged" -
// previously a live/manual check only. Four share the modal-host
// (src/shared/modal.ts); six own-backdrop, guarded via modal-input-lock.ts.

const MARKER = "MARKER";

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_remote: false, any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [{ path: "C:/repo/wt-a", name: "wt-a", tokens_7d: 0, live: 0, last_active_at: null, path_exists: true }],
  last_worktree_path: null, last_start_folder_rel: null,
};

const WORKTREE_DETAILS = [
  { path: "C:/repo/wt-a", name: "wt-a", branch: "feature-a", last_commit_at: null, stale: false, stale_reason: null },
  { path: "C:/repo/wt-b", name: "wt-b", branch: "old-branch", last_commit_at: null, stale: true, stale_reason: "branch deleted upstream" },
];

const ACCOUNT = {
  id: "acc1", label: "Fleet-3", colour: "#57b894", icon: "robot",
  config_dir: "", chrome_profile_dir: "", email: "", org_uuid: "",
  subscription_tier: "", created_at: "", fleet_eligible: false,
};

const SESSION = sessionInstance({ busy: false, awaiting: "done" });

const BASE_INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [SESSION],
  get_active_sessions: [SESSION],
  list_project_groups: [PROJECT],
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: WORKTREE_DETAILS,
  list_accounts: [ACCOUNT],
};

/** Mounts the sessions view, opens the one session's pane, and marks the
 * composer with a fixed value - stands in for "the currently active chat". */
async function mountWithComposer(page: Page) {
  await mountView(page, { view: "sessions", invoke: BASE_INVOKE });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  const composer = page.locator("#session-pane .session-composer .composer-textarea");
  await composer.waitFor();
  await composer.fill(MARKER);
  return composer;
}

/** Presses one plain printable key and asserts the marked composer never saw it. */
async function assertKeySwallowed(page: Page, composer: ReturnType<Page["locator"]>) {
  await page.keyboard.press("2");
  await expect(composer).toHaveValue(MARKER);
}

// ── the four shared-host (src/shared/modal.ts) call sites ─────────────────

async function openProjectPicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.locator(".project-picker-row").waitFor();
}

async function openLocationPicker(page: Page): Promise<void> {
  await openProjectPicker(page);
  await page.locator(".project-picker-row").click();
  await page.locator(".loc-chip").waitFor();
}

async function openWorktreePicker(page: Page): Promise<void> {
  await openLocationPicker(page);
  await page.locator(".loc-chip").click();
  await page.locator(".wt-picker-choice", { hasText: "Existing worktree" }).waitFor();
}

async function openModelEffortModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    void (window as unknown as { __openNewChatModal: () => Promise<unknown> }).__openNewChatModal();
  });
  await page.locator(".model-effort-modal-card").waitFor();
}

// ── the six own-backdrop call sites (lockInputToHost directly) ────────────

/** Isolated, not chained through the picker flow - askConfirm's own guard is
 * the thing under test, and its `cancelBtn.focus()` is what surfaces the
 * finding below regardless of what's underneath it. */
async function openConfirm(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/shared/confirm.ts");
    void mod.askConfirm("Remove this?");
  });
  await page.locator(".app-confirm-overlay").waitFor();
}

async function openChangeAccountModal(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/shared/change-account-modal.ts");
    void mod.openChangeAccountModal({ currentId: "acc1" });
  });
  await page.locator(".cam-modal-card").waitFor();
}

async function openChangeCharacterModal(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/shared/change-character-modal.ts");
    void mod.openChangeCharacterModal({ projectId: "proj1", currentId: null });
  });
  await page.locator(".cc-modal-card").waitFor();
}

async function openNewProjectModal(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/new-project-modal.ts");
    void mod.openNewProjectModal();
  });
  await page.locator(".new-project-card").waitFor();
}

async function openPrReviewModal(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/shared/chat/pr-review-modal.ts");
    const card = document.createElement("div");
    card.dataset.prTitle = "Test PR";
    card.dataset.prCommits = btoa(JSON.stringify([]));
    const tmpl = document.createElement("template");
    tmpl.classList.add("pr-modal-tpl");
    tmpl.innerHTML = "<p>Description</p>";
    card.appendChild(tmpl);
    mod.openPrPreviewModal(card);
  });
  await page.locator(".pr-modal-overlay").waitFor();
}

async function openEditAccountModal(page: Page): Promise<void> {
  await page.evaluate(async (account) => {
    const mod = await import("/views/settings/subviews/accounts/edit-account-modal.ts");
    void mod.openEditAccountModal(account);
  }, ACCOUNT);
  await page.locator(".aem-modal").waitFor();
}

test.describe("view-harness / modal-open must swallow every keystroke (all ten call sites)", () => {
  test("shared-host: project-picker", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openProjectPicker(page);
    await assertKeySwallowed(page, composer);
  });

  test("shared-host: location-picker", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openLocationPicker(page);
    await assertKeySwallowed(page, composer);
  });

  test("shared-host: worktree-picker", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openWorktreePicker(page);
    await assertKeySwallowed(page, composer);
  });

  test("shared-host: model-effort-modal", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openModelEffortModal(page);
    await assertKeySwallowed(page, composer);
  });

  // The regression guard: confirm's focused cancel button is non-editable, so
  // modal-input-lock lets its keydown through by design, and only
  // Composer._globalKeydown's isAnyModalOpen check stops it landing in the composer.
  test("own-backdrop: confirm", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openConfirm(page);
    await assertKeySwallowed(page, composer);
  });

  test("own-backdrop: change-account-modal", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openChangeAccountModal(page);
    await assertKeySwallowed(page, composer);
  });

  test("own-backdrop: change-character-modal", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openChangeCharacterModal(page);
    await assertKeySwallowed(page, composer);
  });

  test("own-backdrop: new-project-modal", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openNewProjectModal(page);
    await assertKeySwallowed(page, composer);
  });

  test("own-backdrop: pr-review-modal", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openPrReviewModal(page);
    await assertKeySwallowed(page, composer);
  });

  test("own-backdrop: edit-account-modal", async ({ page }) => {
    const composer = await mountWithComposer(page);
    await openEditAccountModal(page);
    await assertKeySwallowed(page, composer);
  });
});
