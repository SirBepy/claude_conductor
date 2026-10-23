// asserts: src/views/sessions/project-picker.ts, src/views/sessions/location-picker.ts, src/shared/modal.ts
// Reviewed 2026-10-20 (Mac-mirrored project icon fix): project-picker.ts's row render now passes a machineId to renderAvatar - this spec never selects a peer machine, so it stays null and the markup is unchanged.
// Reviewed 2026-10-23 (peer project stats): project-picker.ts now reads row stats through statFor() and hides the worktree badge on peer rows - this spec only drives the local list, where both are unchanged.
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, delayInvokes } from "./harness";

// Joe, 2026-10-19: after spamming ctrl+n a "Pick project" modal was left on
// screen with nothing clickable - Cancel, a row, nothing - and ctrl+r did
// nothing. Cause: selectProjectRow (project-picker.ts) opens the Location
// step and awaits it, but the picker's OWN Escape handler can still resolve
// the outer picker (finish(null)) in the gap before the Location step has
// painted its own card into the shared slot - onEscapeKeydown's
// `data-picker-step="project"` check still passes because the DOM swap only
// happens once openLocationModal's start() reaches its own presentHostCard()
// call, which (with no worktree choice) sits behind an `await loadScopes()`
// first. When that Location step is later cancelled for real, its `await
// openLocationModal(p)` resolves null back in selectProjectRow, which
// unconditionally re-presented the PICKER's own (already-resolved,
// handlers-now-no-op) card - same class of bug as 7c188e9a's model-effort
// fix, just reached through the picker's nested Location step instead of a
// single cold-load gap.

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_automated: false, last_active_at: null, path_exists: true,
  // No worktree choice: openLocationModal's start() awaits loadScopes()
  // BEFORE ever painting a card, so the project-picker's card (and its own
  // Escape handling) stays the one mounted for the whole delayed window
  // below - the gap this spec races.
  worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
};
// 2+ scopes: list_claude_md_scopes resolving to <=1 would let openLocationModal
// skip the card and resolve instantly, never reaching a real user-cancellable
// Location step at all.
const SCOPES = [
  { rel_path: "", label: "Repo root", nested: false },
  { rel_path: "packages/app", label: "packages/app", nested: true },
];
const DELAY_MS = 300;

async function raceEscapePastTheLocationStep(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [], get_active_sessions: [],
      list_project_groups: [PROJECT], list_accounts: [], list_projects: [],
      resolve_project_account: null, project_last_activity_at: 0, count_ai_todos: 0,
      list_claude_md_scopes: SCOPES,
      get_history: [],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  // Widens loadScopes()'s own gap well past the 150ms morph, so the race
  // below isn't pinned to a single-digit-ms CSS-animation window.
  await delayInvokes(page, ["list_claude_md_scopes"], DELAY_MS);
  await page.locator("#viewMoreBtn").waitFor();
  await page.keyboard.press("Control+n");
  await page.locator(".project-picker-row").click();
  // Lands while list_claude_md_scopes is still in flight - the project
  // card's own data-picker-step="project" is still the one in the slot.
  await page.keyboard.press("Escape");
}

test.describe("view-harness / project picker survives a raced Location-step cancel", () => {
  test("cancelling the late Location card does not resurrect a dead Pick-project card", async ({ page }) => {
    await raceEscapePastTheLocationStep(page);

    // The outer Escape's own closeHostCard() tears the host down on its own
    // COLLAPSE_MS timer (150ms), well before list_claude_md_scopes's delayed
    // 300ms resolves - confirms the host actually closes, not just that it
    // never opened.
    await expect(page.locator("#modal-host")).not.toHaveClass(/\bopen\b/);
    await expect(page.locator(".project-picker-modal")).toHaveCount(0);

    // openLocationModal's start() now learns its owner (the outer
    // project-picker promise) already resolved via the isCancelled callback,
    // and skips presentHostCard() instead of painting a zombie "Open repo"
    // card once the delayed list_claude_md_scopes lands. Wait past the delay
    // and assert the card never appears at all - no flash, nothing to cancel.
    await page.waitForTimeout(DELAY_MS + 200);
    await expect(page.locator(".wt-picker-modal")).toHaveCount(0);
    await expect(page.locator("#modal-host")).not.toHaveClass(/\bopen\b/);
    await expect(page.locator(".project-picker-modal")).toHaveCount(0);

    // Raw reload bypass (7c188e9a) must stay intact regardless.
    const reloadAllowed = await page.evaluate(() => {
      const ev = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return !ev.defaultPrevented;
    });
    expect(reloadAllowed).toBe(true);
  });
});
