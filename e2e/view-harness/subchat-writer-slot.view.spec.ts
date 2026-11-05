// asserts: src/views/sessions/project-dashboard/project-config/project-settings.ts, src/views/sessions/project-dashboard/project-config/rows.ts, src/views/sessions/project-dashboard/project-config/project-settings.css, src/views/sessions/main-chat.ts, src/views/sessions/sub-list.ts, src/views/sessions/sidebar-hover-card-html.ts
import { test, expect, type Page } from "@playwright/test";
import {
  capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance,
} from "./harness";

// Subchats step 10: the two project settings rows (Check a sub's work, Subs
// changing files) show, save and survive a reload, and a sub held for its
// project's writer slot reads as queued in the sub list and the sidebar hover.
// Drives the real project settings renderer and the real sessions view at
// desktop and phone width.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };
const CWD = "C:/work/demo";

/** A stand-in backend for the project list: `update_project` merges its patch into
 *  the stored row, so a second render reads what the first one saved. */
async function installProjectBackend(page: Page, projects: Array<Record<string, unknown>>): Promise<void> {
  await page.evaluate((initial) => {
    const tauri = (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } }).__TAURI__;
    const orig = tauri.core.invoke;
    const rows = initial.map((p) => ({ ...p }));
    tauri.core.invoke = (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as { id?: string; patch?: Record<string, unknown> };
      if (cmd === "list_projects") return Promise.resolve(rows.map((r) => ({ ...r })));
      if (cmd === "update_project") {
        const row = rows.find((r) => r.id === a.id);
        if (row) Object.assign(row, a.patch);
        // Answered here, so the harness's own call log never sees it.
        (window as unknown as { __ccInvokeCalls: unknown[] }).__ccInvokeCalls.push({ cmd, args });
        return Promise.resolve(null);
      }
      return orig(cmd, args);
    };
  }, projects);
}

async function renderSettings(page: Page): Promise<void> {
  await page.evaluate(async (cwd) => {
    const { renderProjectSettings } = await import("/views/sessions/project-dashboard/project-config/project-settings.ts");
    document.getElementById("project-config-host")?.remove();
    const host = document.createElement("div");
    host.id = "project-config-host";
    // The settings rail is 270px wide beside the dashboard; the popup is wider.
    host.style.cssText = "width:270px;padding:16px;box-sizing:border-box";
    document.body.appendChild(host);
    await renderProjectSettings(host, cwd);
  }, CWD);
  await page.locator("#project-config-host #subchatWritersSelect option").first().waitFor({ state: "attached" });
}

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / subchat project settings (${label})`, () => {
    async function mount(page: Page, stored: Record<string, unknown> = {}): Promise<void> {
      await page.setViewportSize(size);
      await mountView(page, {
        view: "settings-appearance",
        invoke: { list_accounts: [], resolve_project_account: null, get_ticket_tracker: null, ensure_project: { id: "p1", path: CWD } },
      });
      await page.locator(".kit-row").first().waitFor();
      await installProjectBackend(page, [{ id: "p1", path: CWD, ...stored }]);
      await renderSettings(page);
    }

    test("both rows show with their defaults, inside the rail", async ({ page }) => {
      await mount(page);
      const check = page.locator("#subchatCheckSelect");
      const files = page.locator("#subchatWritersSelect");
      await expect(check).toBeVisible();
      await expect(files).toBeVisible();
      await expect(check).toHaveValue("facts_and_reviewer");
      await expect(files).toHaveValue("one_at_a_time");
      await expect(check.locator("option")).toHaveText(["Facts and a reviewer", "Facts only"]);
      await expect(files.locator("option")).toHaveText(["One at a time", "Worktree each"]);
      await expect(page.locator(".ps-group-title")).toHaveText("Subchats");
      // Nothing spills out of the 270px rail.
      const host = (await page.locator("#project-config-host").boundingBox())!;
      for (const sel of [check, files]) {
        const box = (await sel.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(host.x);
        expect(box.x + box.width).toBeLessThanOrEqual(host.x + host.width + 0.5);
      }
      await capture(page.locator("#project-config-host"), `subchat-settings-rows-${label}`);
    });

    test("a choice saves as one field and is still there after a reload", async ({ page }) => {
      await mount(page);
      await page.locator("#subchatCheckSelect").selectOption("facts_only");
      await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "update_project").length).toBe(1);
      let calls = (await invokeCalls(page)).filter((c) => c.cmd === "update_project");
      expect((calls[0]!.args as { patch: unknown }).patch).toEqual({ subchat_check: "facts_only" });

      await page.locator("#subchatWritersSelect").selectOption("worktree_each");
      await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "update_project").length).toBe(2);
      calls = (await invokeCalls(page)).filter((c) => c.cmd === "update_project");
      expect((calls[1]!.args as { patch: unknown }).patch).toEqual({ subchat_writers: "worktree_each" });

      // A fresh render, as after reopening the popup, reads both back.
      await renderSettings(page);
      await expect(page.locator("#subchatCheckSelect")).toHaveValue("facts_only");
      await expect(page.locator("#subchatWritersSelect")).toHaveValue("worktree_each");
    });

    test("a stored value from the project shows on first render", async ({ page }) => {
      await mount(page, { subchat_check: "facts_only", subchat_writers: "worktree_each" });
      await expect(page.locator("#subchatCheckSelect")).toHaveValue("facts_only");
      await expect(page.locator("#subchatWritersSelect")).toHaveValue("worktree_each");
    });
  });
}

// ---- a queued sub in the list and the hover ------------------------------------

const MAIN_CWD = "C:/Projects/cv-site";
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: MAIN_CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: true, awaiting: null, ...over });

const MAIN = chat("main", "CV redesign", 101);
const HEADER = sub("sub-header", "Header", 102);
const FOOTER = sub("sub-footer", "Footer", 103, {
  busy: false,
  progress: { plan: null, state_since: null, waiting_for: "waiting for the writer before it" },
});

function invokeFor(sessions: unknown[]) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: ["main"],
    get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    list_slash_commands: [],
    list_auto_accept: [],
  };
}

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / queued sub (${label})`, () => {
    test("the sub list shows a sub held for the writer as waiting, in yellow, among the running ones", async ({ page }) => {
      await page.setViewportSize(size);
      await mountView(page, { view: "sessions", invoke: invokeFor([MAIN, HEADER, FOOTER]) });
      await page.locator("#sessions-list li").first().waitFor();
      await page.waitForTimeout(250);
      await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
      await page.locator('#sessions-list li[data-session-id="main"]').click();
      await page.locator("#session-pane .session-header .sub-count-btn").click();
      const queued = page.locator('.sub-list-popover .sub-row[data-sub-id="sub-footer"]');
      await expect(queued).toBeVisible();
      await expect(queued).toHaveAttribute("data-kind", "queued");
      await expect(queued.locator(".sub-status")).toHaveText("waiting for the writer before it");
      // Running group: the working sub, then the queued one.
      const names = await page.locator(".sub-list-popover .sub-row .sub-name").allTextContents();
      expect(names).toEqual(["Header", "Footer"]);
      await capture(page.locator(".sub-list-popover"), `queued-sub-list-${label}`);
    });
  });
}

test.describe("view-harness / queued sub (desktop hover)", () => {
  test("the main chat's hover card lists the queued sub with the waiting words and the working yellow", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { view: "sessions", invoke: invokeFor([MAIN, HEADER, FOOTER]) });
    await page.locator("#sessions-list li").first().waitFor();
    await page.waitForTimeout(250);
    const row = page.locator('#sessions-list li[data-session-id="main"]');
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    const card = page.locator(".cc-row-card");
    await expect(card).toBeVisible();
    const rows = card.locator(".hc-subrow");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("Footer");
    await expect(rows.nth(1)).toContainText("waiting for the writer before it");
    const colours = await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector(".hc-dot")!).backgroundColor));
    expect(colours[1]).toBe(colours[0]);
    // The sidebar shows no red dot for a sub that is only waiting.
    await expect(row.locator(".ask-dot")).toHaveCount(0);
  });
});
