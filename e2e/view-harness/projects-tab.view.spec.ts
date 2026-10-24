import { test, expect, type Page } from "@playwright/test";
// asserts: src/views/sessions/projects-tab/projects-tab.ts, src/views/sessions/projects-tab/projects-list.ts, src/views/sessions/projects-tab/dashboard.ts, src/views/sessions/projects-tab/dash-sections.ts, src/views/sessions/projects-tab/dash-cards.ts, src/views/sessions/projects-tab/dash-reports.ts, src/views/sessions/projects-tab/dash-header.ts, src/views/sessions/projects-tab/dash-modals.ts, src/views/sessions/projects-tab/dash-kebab.ts, src/views/sessions/projects-tab/dash-chats.ts, src/views/sessions/projects-tab/quick-track.ts, src/views/sessions/projects-tab/open-picker.ts, src/views/sessions/projects-tab/paging.ts, src/views/sessions/state.ts, src/views/sessions/session-controls.ts
// Reviewed 2026-10-24: dash-cards.ts gained the html display kind (a sandboxed frame, dashboard-html-card.view.spec.ts); stats and list cards render as before, so this spec's contract is unaffected.
import { capture, fireEvent, mountSessionsList, sessionInstance } from "./harness";
import {
  CONDUCTOR_CWD, LIST_ROWS, ZIRTUE_CWDS, conductorHistory, conductorSnapshot, fakeShot, zirtueHistory, zirtueSnapshot,
} from "./projects-tab-fixtures";

// The Projects tab against a fake dashboard backend: tab swap, both dashboard
// shapes (one repo, a four-repo group with two custom cards), the column
// balancing, the Past results footer and modal, the cards modal, and the
// click that hands a running chat back to the Chats tab.

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
    for (const id of ["your_todos", "chats", "next_up", "ship", "running", "reports"]) {
      await expect(card(page, id)).toBeVisible();
    }
    await expect(page.locator(".pd-qa .pd-chip").first()).toHaveText("+ New chat");
    await expect(page.locator(".pd-qa .pd-chip").nth(1)).toContainText("/pickup");
    // Past results are only the footer's links; nothing of them sits on the page.
    await expect(card(page, "reports")).toHaveClass(/\bpd-foot\b/);
    await expect(page.locator(".pd-root .pd-out")).toHaveCount(0);
    await page.waitForTimeout(250); // row background transition
    await capture(page, "r2-projects-conductor");
  });

  test("a four-repo group shows its repo count, one ship row per repo and both custom cards", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();

    await expect(page.locator('.pd-root[data-pd-target="group:g-zirtue"] .pd-head h3')).toHaveText("Zirtue");
    await expect(projectRow(page, "Zirtue")).toHaveClass(/\bactive\b/);
    await expect(projectRow(page, "claude_usage_in_taskbar")).not.toHaveClass(/\bactive\b/);
    await expect(page.locator(".pd-root .pd-subline")).toHaveText("4 repos");
    await expect(page.locator(".pd-repo-chip")).toHaveCount(0);
    await expect(card(page, "ship").locator(".pd-row")).toHaveCount(4);
    await expect(card(page, "card:c-sc").locator(".pd-row")).toHaveCount(3);
    await expect(card(page, "card:c-sc").locator(".pd-fetched")).toHaveText("fetched 6m ago");
    await expect(card(page, "card:c-sc").locator(".pd-headline")).toContainText("12 updates since /shortcut-priorities ran 2d ago");
    await expect(card(page, "card:c-ck").locator(".pd-prog-label")).toHaveText("14h 30m of 20h this week");
    await expect(card(page, "card:c-ck").locator(".pd-hl-t.warn")).toContainText("3 workdays not logged");
    await expect(card(page, "your_todos")).toHaveCount(0);
    await page.waitForTimeout(250);
    await capture(page, "r2-projects-zirtue");
  });

  test("the Past results footer opens the modal on the chosen tab, which loads the gallery and opens an image", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await page.locator('.pd-foot [data-pd-see-more="gallery"]').click();
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
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();
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
    await expect(root.locator(".pd-col").first().locator(":scope > [data-pd-card]"))
      .toHaveCount(4);
    const order = await root.locator(".pd-col").first().locator(":scope > [data-pd-card]")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.pdCard));
    expect(order).toEqual(["next_up", "ship", "card:c-sc", "card:c-ck"]);
  });

  test("the Past results footer stays on the pane's bottom edge, whether the page is short or scrolled", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    const root = page.locator('.pd-root[data-pd-target="project:p-conductor"]');
    await expect(root.locator(".pd-foot")).toBeVisible();
    const gap = async (): Promise<number> => root.evaluate((el) =>
      el.getBoundingClientRect().bottom - el.querySelector(".pd-foot")!.getBoundingClientRect().bottom);

    // A pane taller than the page: the footer drops to the bottom instead of following the last section.
    await page.setViewportSize({ width: 1032, height: 2400 });
    await expect.poll(gap).toBeLessThan(1);
    // A pane shorter than the page: the footer sticks to the bottom at the top of the scroll too.
    await page.setViewportSize({ width: 1032, height: 600 });
    await root.evaluate((el) => { el.scrollTop = 0; });
    await expect.poll(gap).toBeLessThan(1);
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
    await expect(modal.locator(".pd-mrow")).toHaveCount(9 + 1 + 7 + 2);
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
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();
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
      const ids = ["next_up", "ship", "card:c-sc", "card:c-ck"];
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

  test("Chats: one list, live chats in group order with no gaps, then three closed ones under a label", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
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
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();
    const next = card(page, "next_up");
    await expect(next.locator(".pd-row")).toHaveCount(3);
    await expect(next.locator(".pd-row").first()).toHaveAttribute("title", /decide on a ticket template/);
    await expect(next.locator("[data-pd-pager]")).toContainText("1/2");
    await next.locator('[data-pd-pager] button[title="Next"]').click();
    await expect(next.locator(".pd-row").first()).toContainText("#90");
  });

  test("quick actions stay on one line led by New chat, and a wheel turn scrolls them sideways with a passing scrollbar", async ({ page }) => {
    await mountWithDashboard(page);
    await page.locator('[data-pd-tab="projects"]').click();
    await projectRow(page, "Zirtue").click();
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
