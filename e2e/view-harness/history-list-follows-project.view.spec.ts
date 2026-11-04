// asserts: src/views/history/history.ts
import { test, expect, type Page } from "@playwright/test";
import { invokeCalls, mountView, SESSIONS_BASE_INVOKE } from "./harness";

// Opening a closed chat from a project's dashboard queues only its session id.
// The History view's left list used to show the newest 200 chats of EVERY
// project beside it; it has to follow the opened chat's project instead.

const entry = (id: string, project: string, cwd: string) => ({
  session_id: id, project_id: project, cwd, title: `Chat ${id}`,
  started_at: 1_700_000_000, ended_at: 1_700_000_100, message_count: 4,
  last_kind: "interactive", last_status: "done", model: "claude-opus-5",
});

const ALPHA_1 = entry("a1", "-proj-alpha", "C:/Projects/alpha");
const ALPHA_2 = entry("a2", "-proj-alpha", "C:/Projects/alpha");
const BETA_1 = entry("b1", "-proj-beta", "C:/Projects/beta");
const ALL = [BETA_1, ALPHA_1, ALPHA_2];

/** list_history answers by its projectId argument, the way the real command filters. */
async function mockListHistory(page: Page): Promise<void> {
  await page.evaluate((all) => {
    const tauri = (window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    }).__TAURI__;
    const real = tauri.core.invoke;
    tauri.core.invoke = (cmd, args) => {
      if (cmd !== "list_history") return real(cmd, args);
      (window as unknown as { __ccInvokeCalls: unknown[] }).__ccInvokeCalls.push({ cmd, args });
      const scope = (args?.projectId as string | null) ?? null;
      return Promise.resolve(scope ? all.filter((e) => e.project_id === scope) : all);
    };
  }, ALL);
}

async function openQueued(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const history = await import("/views/history/history.ts");
    const nav = await import("/shared/navigation.ts");
    history.queueHistorySelect(id);
    nav.showView("history");
  }, sessionId);
}

const rows = (page: Page) => page.locator("#history-list li[data-session-id]");

test("a queued closed chat shows only its own project's chats in the left list", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await mountView(page, {
    invoke: { ...SESSIONS_BASE_INVOKE, load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false, continues_from: null } },
  });
  await mockListHistory(page);

  await openQueued(page, "a1");

  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toHaveAttribute("data-session-id", "a1");
  await expect(rows(page).nth(1)).toHaveAttribute("data-session-id", "a2");
  await expect(page.locator('#history-list li[data-session-id="a1"]')).toHaveClass(/active/);

  const scoped = (await invokeCalls(page))
    .filter((c) => c.cmd === "list_history")
    .map((c) => (c.args as { projectId: string | null }).projectId);
  expect(scoped.at(-1)).toBe("-proj-alpha");
});

test("opening History with nothing queued still lists every project", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await mountView(page, {
    invoke: { ...SESSIONS_BASE_INVOKE, load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false, continues_from: null } },
  });
  await mockListHistory(page);

  await page.evaluate(async () => {
    const nav = await import("/shared/navigation.ts");
    nav.showView("history");
  });

  await expect(rows(page)).toHaveCount(3);
});
