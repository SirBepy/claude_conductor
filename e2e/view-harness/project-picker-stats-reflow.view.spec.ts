// asserts: src/views/sessions/project-picker.ts
// Reviewed 2026-10-20 (Mac-mirrored project icon fix): project-picker.ts's row render now passes a machineId to renderAvatar - this spec never selects a peer machine, so it stays null and the markup is unchanged.
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Each project's last-activity stat lands via a SEPARATE request
// (new-session-cache.ts's projectStatData, one invoke per project). Under
// "Most recent" sort, re-rendering on every single arrival used to reshuffle
// the list one row at a time as each stat landed - visible jumping (Joe's
// report). project-picker.ts now coalesces arrivals that land close together
// into one re-render via scheduleStatsRender's 80ms window, instead of one
// render per project.
//
// Delays below are staggered within that window (well apart from each other,
// to prove they land as separate async arrivals, not a single batched
// response) but deliberately far from 0 - list_project_groups resolves
// instantly, but warmNewSessionCache() ALSO warms these same stats at boot
// (shared cache entry, swr() dedupes the underlying fetch either way), so a
// short delay risks the stats already being resolved by the time the picker
// opens, which would make this test pass by accident regardless of the fix.
//
// Reviewed against project-picker.ts's new cold-load skeleton + row entrance
// animation: the entrance class only applies on the one cold->warm render
// this test samples past immediately (it's gone by the time any stat lands),
// and it never touches row text content, which is all orderLog reads. Ran
// this file after that change - still passes.

const PROJECTS = [
  { id: "p-alpha", path: "C:/Projects/alpha", name: "alpha", parent_segment: null, avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0, any_automated: false, last_active_at: null, path_exists: true, worktrees: [], last_worktree_path: null, last_start_folder_rel: null },
  { id: "p-beta", path: "C:/Projects/beta", name: "beta", parent_segment: null, avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0, any_automated: false, last_active_at: null, path_exists: true, worktrees: [], last_worktree_path: null, last_start_folder_rel: null },
  { id: "p-gamma", path: "C:/Projects/gamma", name: "gamma", parent_segment: null, avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0, any_automated: false, last_active_at: null, path_exists: true, worktrees: [], last_worktree_path: null, last_start_folder_rel: null },
];

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: PROJECTS,
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: [],
};

// Resolves project_last_activity_at per-path, each after its own delay,
// instead of harness.ts's flat static value - so "arrives separately, close
// together in time" is real, not simulated by a single mocked response.
async function stagewiseActivity(
  page: Page,
  entries: Array<{ cwd: string; mtime: number; delayMs: number }>,
): Promise<void> {
  await page.addInitScript((entries) => {
    const w = window as unknown as {
      __TAURI__?: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    };
    const tauri = w.__TAURI__;
    if (!tauri) return;
    const orig = tauri.core.invoke;
    const byPath = new Map(entries.map((e) => [e.cwd, e]));
    tauri.core.invoke = (cmd: string, args?: Record<string, unknown>) => {
      const hit = cmd === "project_last_activity_at" && args?.cwd ? byPath.get(args.cwd as string) : undefined;
      if (hit) return new Promise((resolve) => setTimeout(() => resolve(hit.mtime), hit.delayMs));
      return orig(cmd, args);
    };
  }, entries);
  await page.reload();
}

test.describe("view-harness / project picker stats-settle reflow", () => {
  test("Most-recent sort settles once, not one reshuffle per project", async ({ page }) => {
    await mountView(page, { invoke: BASE_INVOKE });
    await page.evaluate(() => localStorage.setItem("claude_companion_sessions_modal_sort", "recent"));
    // Final order (descending mtime) is gamma, beta, alpha - the OPPOSITE of
    // list_project_groups' own array order (alpha, beta, gamma), which is
    // what the picker shows before any stat has landed (all tied at the
    // mtime-unknown fallback of 0).
    await stagewiseActivity(page, [
      { cwd: "C:/Projects/alpha", mtime: 100, delayMs: 300 },
      { cwd: "C:/Projects/beta", mtime: 200, delayMs: 315 },
      { cwd: "C:/Projects/gamma", mtime: 300, delayMs: 330 },
    ]);

    await page.evaluate(() => {
      void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
    });
    await page.waitForSelector(".project-picker-row");

    const orderLog = await page.evaluate(() => {
      return new Promise<string[]>((resolve) => {
        const log: string[] = [];
        const sample = () => {
          const names = Array.from(document.querySelectorAll(".project-picker-name"))
            .map((el) => el.textContent?.trim().replace(/\u00a0/g, "") ?? "");
          const snap = names.join(",");
          if (log[log.length - 1] !== snap) log.push(snap);
        };
        sample();
        const iv = setInterval(sample, 5);
        setTimeout(() => { clearInterval(iv); resolve(log); }, 600);
      });
    });

    expect(orderLog[0]).toBe("alpha,beta,gamma");
    expect(orderLog[orderLog.length - 1]).toBe("gamma,beta,alpha");
    // Without the fix this settles through an intermediate order per project
    // as each one's stat lands (3+ distinct snapshots here); coalesced into
    // one re-render, it jumps straight from the initial order to the final
    // one.
    expect(orderLog.length).toBeLessThanOrEqual(2);
  });
});
