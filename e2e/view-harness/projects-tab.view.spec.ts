import { test, expect, type Page } from "@playwright/test";
// asserts: src/views/sessions/projects-tab/projects-tab.ts, src/views/sessions/projects-tab/projects-list.ts, src/views/sessions/projects-tab/dashboard.ts, src/views/sessions/projects-tab/dash-sections.ts, src/views/sessions/projects-tab/dash-cards.ts, src/views/sessions/projects-tab/dash-reports.ts, src/views/sessions/projects-tab/dash-header.ts, src/views/sessions/projects-tab/dash-modals.ts, src/views/sessions/projects-tab/dash-kebab.ts, src/views/sessions/projects-tab/dash-chats.ts, src/views/sessions/projects-tab/quick-track.ts, src/views/sessions/projects-tab/open-picker.ts, src/views/sessions/projects-tab/paging.ts, src/views/sessions/state.ts, src/views/sessions/session-controls.ts
import { capture, mountSessionsList, sessionInstance } from "./harness";
import {
  CONDUCTOR_CWD, LIST_ROWS, ZIRTUE_CWDS, conductorHistory, conductorSnapshot, fakeShot, zirtueHistory, zirtueSnapshot,
} from "./projects-tab-fixtures";

// The Projects tab against a fake dashboard backend: tab swap, both dashboard
// shapes (one repo, a four-repo group with two custom cards), the cards modal,
// and the click that hands a running chat back to the Chats tab.

const SESSIONS = [
  sessionInstance({ session_id: "s-w", pid: 201, name: "Loop todos: cycle 3", cwd: CONDUCTOR_CWD, busy: true, awaiting: "working" }),
  sessionInstance({ session_id: "s-q", pid: 202, name: "Projects dashboard brainstorm", cwd: CONDUCTOR_CWD, awaiting: "question" }),
  sessionInstance({ session_id: "z-w", pid: 203, name: "ACH retry backoff", cwd: ZIRTUE_CWDS[2]!, busy: true, awaiting: "working" }),
];

interface Backend {
  list: unknown;
  snapshots: Record<string, unknown>;
  histories: Record<string, unknown>;
  shots: string[];
}

/** Answers the dashboard_* commands from one fixture set. The harness mock only
 *  returns static values, but a snapshot depends on which target was asked for. */
async function fakeDashboardBackend(page: Page, backend: Backend): Promise<void> {
  await page.addInitScript((b) => {
    let tauri: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } | undefined;
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      get: () => tauri,
      set: (v) => {
        const real = v.core.invoke;
        v.core.invoke = (cmd: string, args?: Record<string, unknown>) => {
          const answer = (value: unknown): Promise<unknown> => {
            (window as unknown as { __ccInvokeCalls: unknown[] }).__ccInvokeCalls.push({ cmd, args });
            return Promise.resolve(value);
          };
          const key = args && typeof args.target === "object" ? (args.target as { id: string }).id : "";
          switch (cmd) {
            case "dashboard_list_targets": return answer(JSON.parse(JSON.stringify(b.list)));
            case "dashboard_close_target":
            case "dashboard_open_target": {
              const id = (args?.target as { id: string }).id;
              const row = (b.list as Array<{ target: { id: string }, open?: boolean }>).find((r) => r.target.id === id);
              if (row) row.open = cmd === "dashboard_open_target";
              return answer(null);
            }
            case "dashboard_snapshot": return answer(b.snapshots[key]);
            case "dashboard_history": return answer(b.histories[key]);
            case "dashboard_gallery_image": return answer(b.shots[Number(String(args?.id).replace("img-", ""))] ?? b.shots[0]);
            case "dashboard_card_refresh":
            case "dashboard_card_set_enabled":
            case "dashboard_card_delete":
            case "dashboard_builtin_set_hidden": return answer(null);
            case "dashboard_set_pinned_actions": return answer(args?.actions);
            default: return real(cmd, args);
          }
        };
        tauri = v;
      },
    });
  }, backend);
}

async function mountWithDashboard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1032, height: 1340 });
  await fakeDashboardBackend(page, {
    list: LIST_ROWS,
    snapshots: { "p-conductor": conductorSnapshot(), "g-zirtue": zirtueSnapshot() },
    histories: { "p-conductor": conductorHistory(), "g-zirtue": zirtueHistory() },
    shots: [0, 1, 2, 3, 4, 5].map(fakeShot),
  });
  await mountSessionsList(page, SESSIONS, {
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
  });
}

const projectRow = (page: Page, name: string) => page.locator("#projects-list li.row-portrait", { hasText: name });
const card = (page: Page, id: string) => page.locator(`.pd-root [data-pd-card="${id}"]`);

test.describe("view-harness / Projects tab", () => {
  test("Projects tab lists targets by recency and paints the first dashboard", async ({ page }) => {
    await mountWithDashboard(page);
    await expect(page.locator("#sessions-list")).toBeVisible();

    await page.locator('[data-pd-tab="projects"]').click();
    await expect(page.locator("#sessions-list")).toBeHidden();
    await expect(page.locator("#projects-list")).toBeVisible();
    await expect(page.locator("#projects-list li.row-portrait")).toHaveCount(4);
    await expect(projectRow(page, "claude_usage_in_taskbar")).toHaveClass(/\bactive\b/);
    await expect(projectRow(page, "Zirtue").locator(".proj-name")).toContainText("4 repos");

    const root = page.locator('.pd-root[data-pd-target="project:p-conductor"]');
    await expect(root.locator(".pd-head h3")).toHaveText("claude_usage_in_taskbar");
    await expect(root.locator(".pd-branch")).toHaveText("master ↑2");
    for (const id of ["needs_you", "your_todos", "chats", "next_up", "ship", "running", "reports"]) {
      await expect(card(page, id)).toBeVisible();
    }
    await expect(page.locator(".pd-qa .pd-chip").first()).toContainText("/pickup");
    await expect(card(page, "reports").locator(".pd-out")).toHaveCount(3);
    await page.waitForTimeout(250); // row background transition
    await capture(page, "r2-projects-conductor");
  });

  test("a four-repo group shows repo chips, one ship row per repo and both custom cards", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();

    await expect(page.locator('.pd-root[data-pd-target="group:g-zirtue"] .pd-head h3')).toHaveText("Zirtue");
    await expect(projectRow(page, "Zirtue")).toHaveClass(/\bactive\b/);
    await expect(projectRow(page, "claude_usage_in_taskbar")).not.toHaveClass(/\bactive\b/);
    await expect(page.locator(".pd-repo-chip")).toHaveCount(5);
    await expect(card(page, "ship").locator(".pd-row")).toHaveCount(4);
    await expect(card(page, "card:c-sc").locator(".pd-row")).toHaveCount(3);
    await expect(card(page, "card:c-sc").locator(".pd-fetched")).toHaveText("fetched 6m ago");
    await expect(card(page, "card:c-sc").locator(".pd-headline")).toContainText("12 updates since /shortcut-priorities ran 2d ago");
    await expect(card(page, "card:c-ck").locator(".pd-prog-label")).toHaveText("14h 30m of 20h this week");
    await expect(card(page, "card:c-ck").locator(".pd-hl-t.warn")).toContainText("3 workdays not logged");
    await expect(card(page, "your_todos")).toHaveCount(0);
    await page.waitForTimeout(250);
    await capture(page, "r2-projects-zirtue");

    await page.locator(".pd-repo-chip", { hasText: "zng-biller" }).click();
    await expect(card(page, "chats").locator(".pd-row")).toHaveCount(1);
    await expect(card(page, "ship").locator(".pd-kv").first()).toBeVisible();
  });

  test("Reports gallery loads images one by one", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await card(page, "reports").locator(".pd-rtab", { hasText: "Gallery" }).click();
    await expect(card(page, "reports").locator(".pd-shot img")).toHaveCount(4);
    await page.waitForTimeout(250);
    await capture(page, "r4-reports-gallery");
    await expect(card(page, "reports").locator(".pd-rtab.on")).toHaveText("Gallery");

    await card(page, "reports").locator("[data-pd-see-more]").click();
    const modal = page.locator(".pd-modal.wide");
    await expect(modal.locator(".pd-shot img")).toHaveCount(6);
    await page.waitForTimeout(350); // open morph
    await capture(page, "r2-reports-see-more");
    await modal.locator(".btn-primary").click();
    await expect(modal).toHaveCount(0);

    await card(page, "reports").locator(".pd-shot img").first().click();
    await expect(page.locator(".pd-lightbox img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".pd-lightbox")).toHaveCount(0);
  });

  test("Reports keeps its natural height, so the page ends under it instead of stretching it into a blank box", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    const reports = card(page, "reports");
    await expect(reports.locator(".pd-out")).toHaveCount(3);
    const height = async (): Promise<number> => (await reports.boundingBox())!.height;
    const atDefault = await height();
    await page.setViewportSize({ width: 1032, height: 2000 });
    await page.waitForTimeout(100);
    expect(Math.abs((await height()) - atDefault)).toBeLessThan(1);
  });

  test("the kebab opens the Dashboard cards modal with switches for every section", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();
    await page.locator('.pd-head button[title="More"]').click();
    await page.locator(".smore-item", { hasText: "Dashboard cards" }).click();

    const modal = page.locator(".pd-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".pd-msec")).toHaveText(["Quick actions", "Sections", "Custom cards"]);
    await expect(modal.locator("[data-pd-pin]")).toHaveCount(9);
    await expect(modal.locator(".pd-mrow")).toHaveCount(9 + 1 + 8 + 2);
    await expect(modal).toContainText("Ask Claude in a chat here to add a card");
    await expect(modal).not.toHaveClass(/modal-card-morph-hidden/);
    await page.waitForTimeout(350); // open morph
    await capture(page, "r2-cards-modal-pins");

    await modal.locator(".pd-pin-input").fill("close");
    await modal.locator(".pd-pin-btn").click();
    await expect(modal.locator(".pd-err")).toHaveText("/close cannot be pinned");
    await modal.locator(".pd-pin-input").fill("recap");
    await modal.locator(".pd-pin-input").press("Enter");
    await expect(modal.locator("[data-pd-pin]").last()).toHaveAttribute("data-pd-pin", "/recap");
    await modal.locator('[data-pd-pin="/recap"] button[title="Move up"]').click();
    await expect(modal.locator("[data-pd-pin]").nth(8)).toHaveAttribute("data-pd-pin", "/recap");
    await modal.locator('[data-pd-pin="/recap"] button[title="Remove"]').click();
    await expect(modal.locator("[data-pd-pin]")).toHaveCount(9);
  });

  test("clicking a running chat flips to Chats and selects it", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await card(page, "chats").locator(".pd-row", { hasText: "Loop todos: cycle 3" }).click();

    await expect(page.locator(".sessions-sidebar")).not.toHaveClass(/is-projects-tab/);
    await expect(page.locator('[data-pd-tab="chats"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('#sessions-list li[data-session-id="s-w"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator("#session-pane .session-header")).toBeVisible();
    await expect(page.locator(".pd-root")).toHaveCount(0);
  });

  test("returning to Chats restores the chat that was open, and the tab rests cleanly", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('#sessions-list li[data-session-id="s-q"]').click();
    await expect(page.locator("#session-pane .session-header")).toBeVisible();

    await page.locator('[data-pd-tab="projects"]').click();
    await expect(page.locator(".pd-root")).toBeVisible();
    await expect(page.locator("#session-pane .session-header")).toHaveCount(0);

    await page.locator('[data-pd-tab="chats"]').click();
    await expect(page.locator('#sessions-list li[data-session-id="s-q"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator("#session-pane .session-header")).toBeVisible();
    await page.waitForTimeout(250);
    await capture(page, "projects-tab-chats-at-rest");
  });

  test("Chats card: Current keeps the sidebar's group order with no sub-labels, Recent lists ended ones", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    const chats = card(page, "chats");
    await expect(chats.locator(".pd-rtab.on")).toHaveText("Current");
    await expect(chats.locator(".pd-row.is-gap")).toHaveCount(1);
    await expect(chats.locator("[data-pd-pager]")).toContainText("1/2");
    await chats.locator('[data-pd-pager] button[title="Next"]').click();
    await expect(chats.locator(".pd-row.is-gap")).toHaveCount(0);

    await chats.locator(".pd-rtab", { hasText: "Recent" }).click();
    await expect(chats.locator(".pd-row")).toHaveCount(3);
    await expect(chats).toContainText("Phone question sheet peek");
  });

  test("Next up shows three summarized items with the full text in the tooltip, and a pager", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();
    const next = card(page, "next_up");
    await expect(next.locator(".pd-row")).toHaveCount(3);
    await expect(next.locator(".pd-row").first()).toHaveAttribute("title", /decide on a ticket template/);
    await expect(next.locator("[data-pd-pager]")).toContainText("1/2");
    await next.locator('[data-pd-pager] button[title="Next"]').click();
    await expect(next.locator(".pd-row").first()).toContainText("#90");
  });

  test("quick actions stay on one line and a right press pages the track forward", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();
    const qa = page.locator(".pd-qa");
    await expect(qa.locator(".pd-chip").first()).toHaveText("/shortcut-priorities");
    const tops = await qa.locator(".pd-chip").evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetTop));
    expect(new Set(tops).size).toBe(1);
    await expect(qa).not.toHaveClass(/is-fit/);
    await expect(qa.locator('[data-pd-qa-dir="-1"]')).toBeDisabled();

    const strip = qa.locator(".pd-qa-strip");
    await qa.locator('[data-pd-qa-dir="1"]').click();
    await expect(qa.locator('[data-pd-qa-dir="-1"]')).toBeEnabled();
    await expect(strip).not.toHaveCSS("transform", /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    await page.waitForTimeout(350); // slide transition
    await capture(page, "r2-quick-actions-paged");

    await qa.locator('[data-pd-qa-dir="-1"]').click();
    await expect(qa.locator('[data-pd-qa-dir="-1"]')).toBeDisabled();
  });

  test("closing a project hides its row, Ctrl+W closes the shown one, and + reopens from the picker", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await expect(page.locator("#projects-list li.row-portrait")).toHaveCount(4);

    await projectRow(page, "dashboard-a").hover();
    await projectRow(page, "dashboard-a").locator(".pd-row-x").click();
    await expect(page.locator("#projects-list li.row-portrait")).toHaveCount(3);
    await expect(projectRow(page, "dashboard-a")).toHaveCount(0);

    await projectRow(page, "Zirtue").click();
    await expect(page.locator('.pd-root[data-pd-target="group:g-zirtue"]')).toBeVisible();
    await page.keyboard.press("Control+w");
    await expect(projectRow(page, "Zirtue")).toHaveCount(0);

    await page.locator(".pd-list-add").click();
    const picker = page.locator(".pd-modal");
    await expect(picker.locator(".pd-pick")).toHaveCount(5);
    await page.waitForTimeout(350);
    await capture(page, "r2-open-project-picker");
    await picker.locator(".pd-pick-search").fill("count");
    await expect(picker.locator(".pd-pick")).toHaveCount(1);
    await picker.locator(".pd-pick").click();
    await expect(projectRow(page, "countoff")).toHaveClass(/\bactive\b/);
  });
});
