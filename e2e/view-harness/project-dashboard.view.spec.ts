import { test, expect, type Page } from "@playwright/test";
// asserts: src/views/sessions/project-dashboard/dashboard.ts, src/views/sessions/project-dashboard/dashboard-page.ts, src/views/sessions/project-dashboard/draft-dashboard.ts, src/views/sessions/project-dashboard/dash-sections.ts, src/views/sessions/project-dashboard/dash-cards.ts, src/views/sessions/project-dashboard/dash-reports.ts, src/views/sessions/project-dashboard/dash-header.ts, src/views/sessions/project-dashboard/dash-modals.ts, src/views/sessions/project-dashboard/dash-menu.ts, src/views/sessions/project-dashboard/dash-chats.ts, src/views/sessions/project-dashboard/dash-usage.ts, src/views/sessions/project-dashboard/dash-todo-chart.ts, src/views/sessions/project-dashboard/quick-track.ts, src/views/sessions/project-dashboard/paging.ts, src/views/sessions/session-header.ts, src/views/sessions/pending-pane.ts, src/views/sessions/session-controls.ts, src/views/sessions/state.ts
import { capture, fireEvent, mountSessionsList, sessionInstance } from "./harness";
import {
  CONDUCTOR_CWD, LIST_ROWS, ZIRTUE_CWDS, conductorHistory, conductorSnapshot, fakeShot, zirtueHistory, zirtueSnapshot,
} from "./project-dashboard-fixtures";

// The project dashboard against a fake dashboard backend, through its real
// entry points: a chat header's project name and Ctrl+Shift+D open it as a
// page, a new-chat draft shows it above the message box. Both dashboard
// shapes (one repo, a four-repo group with two custom cards), the column
// balancing, the Past results row and modal, the cards modal, the right-click
// menu, and the clicks that hand the pane back to a chat.

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
    // Exposed so a test can change what the next fetch answers.
    (window as unknown as { __ccDashBackend: unknown }).__ccDashBackend = b;
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

const card = (page: Page, id: string) => page.locator(`.pd-root [data-pd-card="${id}"]`);

/** Opens a chat, then its project's dashboard page from the header's project name. */
async function openPageFrom(page: Page, sessionId: string): Promise<void> {
  await page.locator(`#sessions-list li[data-session-id="${sessionId}"]`).click();
  await page.locator("#session-pane .session-header .meta-proj").click();
  await expect(page.locator(".pd-root.is-page")).toBeVisible();
}

async function openDraft(page: Page, path: string, name: string): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate(([p, n]) => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: { model: string; effort: string }) => void })
      .__launchDraftForTest({ path: p!, name: n! }, { model: "claude-opus-5", effort: "high" });
  }, [path, name]);
  await expect(page.locator(".pd-root.is-draft .pd-reports")).toBeVisible();
}

test.describe("view-harness / project dashboard", () => {
  test("the chat header's project name opens the page: back, header, past results first, chips last", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "s-q");

    const root = page.locator('.pd-root[data-pd-target="project:p-conductor"]');
    await expect(root.locator(".pd-head h3")).toHaveText("claude_usage_in_taskbar");
    await expect(root.locator(".pd-branch")).toHaveText("master ↑2");
    await expect(root.locator(".pd-head + .pd-reports")).toBeVisible();
    for (const id of ["your_todos", "chats", "next_up", "ship", "usage", "todo_chart", "running", "reports"]) {
      await expect(card(page, id)).toBeVisible();
    }
    await expect(card(page, "ship").locator("[data-pd-commits]")).toHaveText(["Unpushed (2)", "Pushed"]);
    await expect(card(page, "ship")).not.toContainText("dd1af90");
    await expect(page.locator(".pd-qa-host.is-page .pd-chip").first()).toHaveText("+ New chat");
    await expect(page.locator(".pd-qa-host.is-page .pd-chip").nth(1)).toContainText("/pickup");
    await expect(page.locator(".pd-root .pd-out")).toHaveCount(0);
    // The chip row closes off the pane: nothing of the page sits under it.
    const gap = await page.locator("#session-pane").evaluate((pane) =>
      pane.getBoundingClientRect().bottom - pane.querySelector(".pd-qa-host")!.getBoundingClientRect().bottom);
    expect(gap).toBeLessThan(1);
    await page.waitForTimeout(250);
    await capture(page, "dashboard-page-conductor");

    await root.locator("[data-pd-back]").click();
    await expect(page.locator(".pd-root")).toHaveCount(0);
    await expect(page.locator('#sessions-list li[data-session-id="s-q"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator("#session-pane .session-header")).toBeVisible();
  });

  test("the Todos card draws open, created and done per day, switches range, and reads a day on hover", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "s-q");
    const todos = card(page, "todo_chart");
    await expect(todos.locator(".pd-usage-total")).toContainText("claimed");
    await expect(todos.locator(".pd-todo-legend > span")).toHaveText(["Open", "Created", "Done"]);
    await expect(todos.locator("svg[data-todo-chart] [data-todo-line]")).toHaveCount(3);
    const pointsIn = async (): Promise<number> => Number(await todos.locator("svg[data-todo-chart]").getAttribute("data-n"));
    expect(await pointsIn()).toBe(30);

    await todos.locator('[data-pd-range="7d"]').click();
    await expect(todos.locator('[data-pd-range="7d"]')).toHaveClass(/\bon\b/);
    expect(await pointsIn()).toBe(7);
    await todos.locator('[data-pd-range="all"]').click();
    expect(await pointsIn()).toBe(40);

    const chart = todos.locator(".pd-todo-chart");
    const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
    const tip = todos.locator(".pd-todo-tip");
    await expect(tip).toBeVisible();
    await expect(tip.locator(".pd-todo-tip-date")).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
    await expect(tip).toContainText("Open");
    await capture(page, "dashboard-todo-chart-hover");
    await page.mouse.move(0, 0);
    await expect(tip).toBeHidden();
  });

  test("a group repo's chat opens the group's page: repo count, one ship row per repo, both custom cards", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "z-w");

    await expect(page.locator('.pd-root[data-pd-target="group:g-zirtue"] .pd-head h3')).toHaveText("Zirtue");
    await expect(page.locator(".pd-root .pd-subline")).toHaveText("4 repos");
    await expect(card(page, "ship").locator(".pd-row")).toHaveCount(4);
    await expect(card(page, "card:c-sc").locator(".pd-row")).toHaveCount(3);
    await expect(card(page, "card:c-sc").locator(".pd-fetched")).toHaveText("fetched 6m ago");
    await expect(card(page, "card:c-sc").locator(".pd-headline")).toContainText("12 updates since /shortcut-priorities ran 2d ago");
    await expect(card(page, "card:c-ck").locator(".pd-prog-label")).toHaveText("14h 30m of 20h this week");
    await expect(card(page, "card:c-ck").locator(".pd-hl-t.warn")).toContainText("3 workdays not logged");
    await expect(card(page, "your_todos")).toHaveCount(0);
    // None of the group's repos has a todos folder, so there is no chart.
    await expect(card(page, "todo_chart")).toHaveCount(0);
    await page.waitForTimeout(250);
    await capture(page, "dashboard-page-zirtue");
  });

  test("Ctrl+Shift+D opens the open chat's project page", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('#sessions-list li[data-session-id="s-w"]').click();
    await expect(page.locator("#session-pane .session-header")).toBeVisible();
    await page.keyboard.press("Control+Shift+D");
    await expect(page.locator('.pd-root.is-page[data-pd-target="project:p-conductor"]')).toBeVisible();
  });

  test("a new-chat draft shows the dashboard with no header and its chips right above the message box", async ({ page }) => {
    await mountWithDashboard(page);
    await openDraft(page, CONDUCTOR_CWD, "claude_usage_in_taskbar");

    const root = page.locator(".session-messages .pd-root.is-draft");
    await expect(root.locator(".pd-head")).toHaveCount(0);
    await expect(root.locator(":scope > *").first()).toHaveClass(/\bpd-reports\b/);
    const chips = page.locator(".pd-qa-host.is-draft .pd-chip");
    await expect(chips.first()).toContainText("/pickup");
    await expect(page.locator(".pd-qa-host.is-draft [data-pd-new-chat]")).toHaveCount(0);
    // Just above the bordered message box, lined up with its left edge.
    const chipsBox = await page.locator(".pd-qa-host.is-draft").boundingBox();
    const shellBox = await page.locator(".composer-shell").boundingBox();
    expect(Math.abs(chipsBox!.x - shellBox!.x)).toBeLessThan(1);
    expect(shellBox!.y - (chipsBox!.y + chipsBox!.height)).toBeLessThan(12);
    await page.waitForTimeout(250);
    await capture(page, "dashboard-draft-conductor");

    await chips.first().click();
    await expect(page.locator("#session-pane .composer-shell .composer-textarea")).toHaveValue(/^\/pickup $/);
    await expect(page.locator(".pd-root.is-draft")).toBeVisible();
  });

  test("right-click on a chat row offers its own actions above the project's", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "s-q");
    await card(page, "chats").locator(".pd-row", { hasText: "Loop todos: cycle 3" }).click({ button: "right" });
    const items = page.locator(".session-more-menu .smore-item");
    await expect(items.nth(0)).toHaveText("Open chat");
    await expect(items.nth(1)).toHaveText("Close chat...");
    await expect(items.nth(2)).toHaveText("Rename project...");
    await expect(page.locator(".session-more-menu .smore-sep")).toHaveCount(1);
    await capture(page, "dashboard-context-menu");
    await page.keyboard.press("Escape");

    await card(page, "next_up").click({ button: "right", position: { x: 4, y: 4 } });
    await expect(items.first()).toHaveText("Rename project...");
    await items.filter({ hasText: "Project settings" }).click();
    await expect(page.locator(".pd-modal .pd-config-body .view-project-automation")).toBeVisible();
  });

  test("the Past results row opens the modal on the chosen tab, which loads the gallery and opens an image", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "s-q");
    await page.locator('.pd-reports [data-pd-see-more="gallery"]').click();
    const modal = page.locator(".pd-modal.wide");
    await expect(modal.locator(".pd-rtab.on")).toHaveText("Gallery");
    await expect(modal.locator(".pd-shot img")).toHaveCount(6);
    await page.waitForTimeout(350); // open morph
    await capture(page, "r5-past-results-gallery");

    await modal.locator(".pd-rtab", { hasText: "Outcomes" }).click();
    await expect(modal.locator(".pd-out")).toHaveCount(3);
    await modal.locator(".pd-rtab", { hasText: "Gallery" }).click();
    await modal.locator(".pd-shot img").first().click();
    await expect(page.locator(".pd-lightbox img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".pd-lightbox")).toHaveCount(0);
    await modal.locator(".btn-primary").click();
    await expect(modal).toHaveCount(0);
  });

  test("the half-width sections balance across two columns, then stack in reading order when narrow", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "z-w");
    const root = page.locator('.pd-root[data-pd-target="group:g-zirtue"]');
    await expect(card(page, "card:c-ck")).toBeVisible();

    // Greedy shortest-first placement: the columns' natural heights differ by
    // less than the tallest single section, and neither column is empty.
    const cols = await root.evaluate((el) => [...el.querySelectorAll(".pd-col")].map((col) =>
      [...col.querySelectorAll<HTMLElement>(":scope > [data-pd-card]")].map((sec) => {
        const last = sec.lastElementChild!.getBoundingClientRect();
        return last.bottom - sec.getBoundingClientRect().top;
      })));
    expect(cols[0]!.length).toBeGreaterThan(0);
    expect(cols[1]!.length).toBeGreaterThan(0);
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum(cols[0]!) - sum(cols[1]!))).toBeLessThan(Math.max(...cols.flat()));

    await page.setViewportSize({ width: 860, height: 1340 });
    await expect(root.locator(".pd-col").nth(1).locator("[data-pd-card]")).toHaveCount(0);
    const order = await root.locator(".pd-col").first().locator(":scope > [data-pd-card]")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.pdCard));
    expect(order).toEqual(["next_up", "ship", "usage", "card:c-sc", "card:c-ck"]);
  });

  test("the kebab opens the Dashboard cards modal with switches for every section", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "z-w");
    await page.locator('.pd-head button[title="More"]').click();
    await page.locator(".smore-item", { hasText: "Dashboard cards" }).click();

    const modal = page.locator(".pd-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".pd-msec")).toHaveText(["Quick actions", "Sections", "Custom cards"]);
    await expect(modal.locator("[data-pd-pin]")).toHaveCount(9);
    await expect(modal.locator(".pd-mrow")).toHaveCount(9 + 1 + 9 + 2);
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

  test("a refetch painted while the pane was hidden re-balances the columns once the pane is shown", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "z-w");
    const root = page.locator('.pd-root[data-pd-target="group:g-zirtue"]');
    await expect(card(page, "card:c-ck")).toBeVisible();
    const placement = (): Promise<string[][]> => root.evaluate((el) => [...el.querySelectorAll(".pd-col")].map((col) =>
      [...col.querySelectorAll<HTMLElement>(":scope > [data-pd-card]")].map((s) => s.dataset.pdCard!)));
    const before = await placement();

    // While hidden, Ship state drops to one repo, which moves the balance point.
    // That paint measures every section as 0 and keeps the old placement; only
    // the root's ResizeObserver re-balances once the pane has a size again.
    await page.locator("#session-pane").evaluate((el) => { el.style.display = "none"; });
    await page.evaluate(() => {
      const b = (window as unknown as { __ccDashBackend: { snapshots: Record<string, { ship: unknown[] }> } }).__ccDashBackend;
      b.snapshots["g-zirtue"]!.ship = b.snapshots["g-zirtue"]!.ship.slice(0, 1);
    });
    await fireEvent(page, "dashboard-changed", [null]);
    await expect(card(page, "ship")).not.toContainText("zng-admin");
    expect(await placement()).toEqual(before);

    await page.locator("#session-pane").evaluate((el) => { el.style.display = ""; });
    // The placement a fresh greedy pass would pick from the shown heights.
    const expected = async (): Promise<string[][]> => root.evaluate((el) => {
      const ids = ["next_up", "ship", "usage", "card:c-sc", "card:c-ck"];
      const height = (id: string): number => {
        const sec = el.querySelector<HTMLElement>(`.pd-col > [data-pd-card="${id}"]`)!;
        return sec.lastElementChild!.getBoundingClientRect().bottom - sec.getBoundingClientRect().top;
      };
      const total = [0, 0];
      const cols: string[][] = [[], []];
      for (const id of ids) { const c = total[0]! <= total[1]! ? 0 : 1; total[c]! += height(id); cols[c]!.push(id); }
      return cols;
    });
    await expect.poll(async () => JSON.stringify(await placement()) === JSON.stringify(await expected())).toBe(true);
    expect(await placement()).not.toEqual(before);
  });

  test("clicking a running chat on the page leaves it and selects that chat", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "s-q");
    await card(page, "chats").locator(".pd-row", { hasText: "Loop todos: cycle 3" }).click();

    await expect(page.locator('#sessions-list li[data-session-id="s-w"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator("#session-pane .session-header")).toBeVisible();
    await expect(page.locator(".pd-root")).toHaveCount(0);
  });

  test("Chats: one list, live chats in group order with no gaps, then three closed ones under a label", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "s-q");
    const chats = card(page, "chats");
    await expect(chats.locator(".pd-rtab")).toHaveCount(0);
    await expect(chats.locator(".pd-row.is-gap")).toHaveCount(0);
    await expect(chats.locator(".pd-row")).toHaveCount(4 + 3);
    await expect(chats.locator(".pd-row").first()).toContainText("Projects dashboard brainstorm");
    await expect(chats.locator("[data-pd-past-label]")).toHaveText("Recently closed");
    await expect(chats.locator("[data-pd-pager]")).toContainText("1/2");
    await chats.locator('[data-pd-pager] button[title="Next"]').click();
    await expect(chats.locator(".pd-row")).toHaveCount(1 + 3);
    await expect(chats).toContainText("Phone question sheet peek");
    await expect(chats.locator('[data-pd-all-history][title="History"]')).toBeVisible();
  });

  test("Next up shows three summarized items with the full text in the tooltip, and a pager", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "z-w");
    const next = card(page, "next_up");
    await expect(next.locator(".pd-row")).toHaveCount(3);
    await expect(next.locator(".pd-row").first()).toHaveAttribute("title", /decide on a ticket template/);
    await expect(next.locator("[data-pd-pager]")).toContainText("1/2");
    await next.locator('[data-pd-pager] button[title="Next"]').click();
    await expect(next.locator(".pd-row").first()).toContainText("#90");
  });

  test("quick actions stay on one line led by New chat, and a wheel turn scrolls them sideways with a passing scrollbar", async ({ page }) => {
    await mountWithDashboard(page);
    await openPageFrom(page, "z-w");
    const track = page.locator(".pd-qa-track");
    await expect(track.locator(".pd-chip").first()).toHaveText("+ New chat");
    await expect(track.locator(".pd-chip").nth(1)).toHaveText("/shortcut-priorities");
    const tops = await track.locator(".pd-chip").evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetTop));
    expect(new Set(tops).size).toBe(1);
    await expect(page.locator("[data-pd-qa-dir]")).toHaveCount(0);
    await expect(track).toHaveClass(/\bfade-r\b/);
    await expect(track).not.toHaveClass(/\bfade-l\b/);

    const box = (await track.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect(track).toHaveClass(/\bis-scrolling\b/);
    await expect(track).toHaveClass(/\bfade-l\b/);
    await capture(page, "r5-quick-actions-scrolling");
    // The scrollbar hides again once the row stops moving.
    await expect(track).not.toHaveClass(/\bis-scrolling\b/, { timeout: 3000 });
  });
});
