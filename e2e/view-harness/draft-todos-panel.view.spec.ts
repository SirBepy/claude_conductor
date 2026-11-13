// asserts: src/views/sessions/todos-panel.ts, src/views/sessions/pane-windows/panels.ts, src/views/sessions/split-panels/split.ts, src/views/sessions/pending-pane.ts
import { test, expect, type Page } from "@playwright/test";
import { invokeCalls, mountView, SESSIONS_BASE_INVOKE } from "./harness";
import { CONDUCTOR_CWD, LIST_ROWS, conductorSnapshot } from "./project-dashboard-fixtures";

// Joe, 2026-11-13: "i cant see the todos while in draft menu". A new-chat draft has no
// daemon session yet (its id is a "pending-" placeholder), and the daemon's
// list_user_todos refuses an id it does not know, so the Todos panel opened empty.
// A draft reads its project's open todos the way the draft's own dashboard does.
// Drives the real strip and FAB on a real draft pane.

const TODO_TEXT = "Check Console for the 21:45 UTC haiku call on key test2";

async function openDraft(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [],
      get_active_sessions: [],
      list_subchats_on: [],
      dashboard_list_targets: LIST_ROWS,
      dashboard_snapshot: conductorSnapshot(),
      dashboard_history: null,
      dashboard_todo_set_state: null,
      list_previews: [],
      list_message_drafts: { drafts: [] },
      set_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
      clear_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      context_status: null,
      list_slash_commands: [],
    },
  });
  await page.evaluate(() => {
    const w = window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } };
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      const a = (args ?? {}) as { sessionId?: string };
      // The daemon only knows real sessions; a draft's placeholder is "unknown session".
      if (cmd === "list_user_todos" && (a.sessionId ?? "").startsWith("pending-")) {
        return Promise.reject(`unknown session: ${a.sessionId}`);
      }
      return orig(cmd, args);
    };
  });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate((cwd) => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: object) => void })
      .__launchDraftForTest({ path: cwd, name: "alpha" }, { model: "sonnet", effort: "low", accountId: "acc1", subchatsOn: false });
  }, CONDUCTOR_CWD);
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
}

test.describe("new-chat draft Todos panel", () => {
  test("desktop: the strip's Todos tab lists the project's todos, and ticking one goes through the project", async ({ page }) => {
    await openDraft(page, 1280);
    await page.locator('.sp-tab[data-sp-k="todos"]').click();
    const board = page.locator(".sp-panel .todos-panel");
    await expect(board).toContainText(TODO_TEXT);
    await board.locator('[data-act="toggle"]').first().click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "dashboard_todo_set_state").length).toBe(1);
    const call = (await invokeCalls(page)).find((c) => c.cmd === "dashboard_todo_set_state");
    expect(call?.args).toMatchObject({ projectId: "p-conductor", id: "t1", next: "done" });
  });

  test("phone: the FAB's Todos opens the same list without breaking the draft", async ({ page }) => {
    await openDraft(page, 390);
    await page.locator("[data-fab-toggle]").click();
    await page.locator('[data-dial="todos"]').click();
    await expect(page.locator(".todos-panel").filter({ hasText: TODO_TEXT })).toBeVisible();
    await expect(page.locator("#session-pane .session-composer .composer-textarea")).toBeAttached();
  });
});
