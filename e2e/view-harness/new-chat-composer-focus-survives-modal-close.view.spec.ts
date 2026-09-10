import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE } from "./harness";

// Todo 879: two independent, confirmed causes of the draft-chat composer
// losing the focus pending-pane.ts's mountPendingPane already sets via its
// trailing `ta.focus()`.
//
// 1. (all widths) startNewSession() (pending-flow.ts) calls
//    lockBackgroundInput() before the project-picker/model-effort modal
//    chain, then awaits the whole chain including renderPendingPane()'s
//    `ta.focus()`. The modal's own close path (model-effort-modal.ts's
//    `.me-confirm` handler: `closeHostCard(); resolve(result);`) used to
//    defer releasing the global focus guard via a real
//    `setTimeout(..., COLLAPSE_MS)` inside modal.ts's closeHostCard, instead
//    of releasing it synchronously with the resolved promise. Reproduced by
//    spying on HTMLElement.prototype.focus/blur: `ta.focus()` fired, then a
//    same-tick `blur()` on that exact node, driven by modal-input-lock's
//    global `focusin` guard (still armed) blurring anything outside every
//    locked host. Fixed: closeHostCard() now releases the guard immediately
//    instead of inside the COLLAPSE_MS teardown.
// 2. (mobile/narrow, <=768px) launchNewSession()/resumeDraft() used to flip
//    `.view-sessions[data-mobile-pane]` to "chat" AFTER renderPendingPane()
//    had already returned. `ta.focus()` runs while `.session-pane` still
//    carries `display: none` (sessions-mobile.css's
//    `:not([data-mobile-pane="chat"]) .session-pane`), and focusing an
//    element inside a display:none subtree is a browser no-op - no blur
//    event at all, the focus call just never takes. Fixed: both callers now
//    set the attribute before mounting, mirroring the already-correct
//    pattern in active-session.ts's selectSession().
//
// Both are exercised here via the REAL startNewSession() -> pickProject() ->
// openModelEffortModal() -> launchNewSession() chain (no bypass), with every
// backend call mocked.

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_remote: false, any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
};

const ACCOUNTS = [{ id: "acc1", label: "work", icon: "briefcase", colour: "#8b5cf6" }];

async function mountSessionsEntry(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [],
      get_active_sessions: [],
      list_project_groups: [PROJECT],
      list_accounts: ACCOUNTS,
      list_projects: [],
      resolve_project_account: null,
      project_last_activity_at: 0,
      count_ai_todos: 0,
      list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
      get_history: [],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
}

async function confirmModelEffort(page: Page): Promise<void> {
  await page.locator(".project-picker-row").click();
  const confirmBtn = page.locator(".me-confirm");
  await expect(confirmBtn).toBeVisible();
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
}

async function assertComposerHoldsFocus(page: Page): Promise<void> {
  const ta = page.locator("#session-pane .composer-textarea");
  await ta.waitFor();
  // Give any deferred unlock every chance to have already run if it were
  // going to win the race honestly - this is not testing a narrow first-tick
  // fluke.
  await page.waitForTimeout(400);

  const active = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    cls: document.activeElement instanceof HTMLElement ? document.activeElement.className : null,
  }));
  expect(active.tag).toBe("TEXTAREA");
  expect(active.cls).toContain("composer-textarea");

  // Pasteability is what the focus actually gates - assert the behavioural
  // symptom too, not just activeElement bookkeeping. insertText only lands
  // on whatever DOM node currently has real focus.
  await page.keyboard.insertText("pasted-if-focused");
  await expect(ta).toHaveValue("pasted-if-focused");
}

test.describe("view-harness / new-chat composer focus after modal close", () => {
  test("desktop: composer holds focus once the modal chain resolves", async ({ page }) => {
    await mountSessionsEntry(page);
    await page.locator("#viewMoreBtn").waitFor();
    await page.locator("#viewMoreBtn").click();
    await page.locator("#newSessionBtn").waitFor({ state: "visible" });
    await page.locator("#newSessionBtn").click();
    await confirmModelEffort(page);
    await assertComposerHoldsFocus(page);
  });

  test("mobile: composer holds focus once the pane is revealed", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountSessionsEntry(page);
    // .sessions-fab is the phone entry point to the same startNewSession()
    // the desktop kebab's "+ New session" item calls (see new-session-cold-
    // cache.view.spec.ts) - no bypass of pickProject()/openModelEffortModal().
    await page.locator("#sessionsFab").waitFor();
    await page.locator("#sessionsFab").click();
    await confirmModelEffort(page);
    await assertComposerHoldsFocus(page);
  });
});
