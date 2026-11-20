// asserts: src/views/history/history.ts, src/views/sessions/view-more-menu.ts, src/views/sessions/template.ts, src/views/sessions/project-dashboard/dash-history-modal.ts
import { test, expect, type Page } from "@playwright/test";
import { mountViewPhone, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";
import { CONDUCTOR_CWD, LIST_ROWS, conductorHistory, conductorSnapshot } from "./project-dashboard-fixtures";

// pc-1583: on the phone (HttpTransport, real fetch routed at the network level)
// closed chats are reached from a project dashboard's History modal, never from
// an all-projects list. The Chats menu keeps Scheduled and Preview.

const LIVE = sessionInstance({ session_id: "s-live", pid: 202, name: "Phone chat", cwd: CONDUCTOR_CWD, awaiting: "done" });
const CLOSED = [0, 1, 2].map((i) => ({
  session_id: `h-${i}`, title: `Closed chat ${i}`, status: "ended", repo_cwd: CONDUCTOR_CWD, at_ms: Date.now() - (i + 1) * 600_000,
}));
const ENTRY = {
  session_id: "h-0", project_id: "-proj-conductor", cwd: CONDUCTOR_CWD, title: "Closed chat 0",
  started_at: 1_700_000_000, ended_at: 1_700_000_100, message_count: 4,
  last_kind: "interactive", last_status: "done", model: "claude-opus-5",
};

async function mount(page: Page, hash?: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 800 });
  await mountViewPhone(page, {
    view: hash ?? "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [LIVE],
      get_active_sessions: [LIVE],
      dashboard_list_targets: LIST_ROWS,
      dashboard_snapshot: conductorSnapshot(),
      dashboard_history: conductorHistory(),
      dashboard_closed_chats: CLOSED,
      list_history: [ENTRY],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false, continues_from: null },
    },
  });
}

test.describe("view-harness / phone closed chats (pc-1583)", () => {
  test("the Chats menu keeps Scheduled and Preview and has no History item", async ({ page }) => {
    await mount(page);
    await page.locator("#sessions-list li[data-session-id]").first().waitFor();
    await page.locator("#viewMoreBtn").click();
    const items = page.locator(".view-more-menu .smore-item");
    await expect(items.filter({ hasText: "Scheduled" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Preview" })).toHaveCount(1);
    await expect(items.filter({ hasText: "History" })).toHaveCount(0);
    await expect(page.locator("#historyBtn")).toHaveCount(0);
  });

  test("the project dashboard's History modal lists closed chats over the phone transport", async ({ page }) => {
    await mount(page);
    await page.locator('#sessions-list li[data-session-id="s-live"]').click();
    await page.locator("#session-pane .session-header .meta-proj").click();
    await expect(page.locator(".pd-root.is-page")).toBeVisible();
    await page.locator("[data-pd-past-label] [data-pd-all-history]").click();
    const modal = page.locator(".pd-modal");
    await expect(modal.locator("h3")).toContainText("History");
    await expect(modal.locator(".pd-row")).toHaveCount(CLOSED.length);
    // Picking a row opens that chat read-only in the History view, beside only its own list.
    await modal.locator(".pd-row").first().click();
    await expect(page.locator('#history-list li[data-session-id="h-0"]')).toHaveClass(/active/);
  });

  test("History with no chat queued goes back to Chats instead of listing every project", async ({ page }) => {
    const listCalls: string[] = [];
    page.on("request", (r) => { if (r.url().endsWith("/api/rpc") && (r.postData() ?? "").includes('"list_history"')) listCalls.push(r.postData()!); });
    await mount(page, "history");
    await expect(page.locator("#sessions-list")).toBeVisible();
    await expect(page.locator("#history-list")).toHaveCount(0);
    expect(listCalls).toHaveLength(0);
  });
});
