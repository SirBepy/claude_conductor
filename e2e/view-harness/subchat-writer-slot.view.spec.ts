// Reviewed 2026-11-13 (project-settings.css gained `.view-project-settings .ps-group[hidden] { display: none }` so a hidden group stays hidden): nothing this spec asserts changed. It passes.
// Reviewed 2026-11-12 (release gate): the project settings tests waited on #subchatWritersSelect, which no source file renders since the Subs changing files toggle went (ProjectConfig.subchat_writers is parsed and ignored); they now cover the Check a sub's work row alone, and the queued-sub tests are unchanged.
// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome): nothing this spec asserts changed.
// Reviewed 2026-11-10 (dash lane 3, code-check fixes): comment rewording, a transport case split and a deleted unused getter; nothing this spec asserts changed.
// Reviewed 2026-11-05: sub-list.ts's row button now opens the sub in a new window (data-popout) and the queued row still has none; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-05: a main chat waiting for its subs to close stays in Main chats with an hourglass, the sub list orders Finished by finish time, a sub header wears its list initials and the all-finished card names unmerged subs; this spec asserts none of those and it passes.
// Reviewed 2026-11-05: main-chat.ts, sub-list.ts and the hover card html gained a per-sub tier (and a closing flag); the queued row's text, dot and ring are unchanged and this spec passes.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/project-dashboard/project-config/project-settings.ts, src/views/sessions/project-dashboard/project-config/rows.ts, src/views/sessions/project-dashboard/project-config/project-settings.css, src/views/sessions/main-chat.ts, src/views/sessions/sub-list.ts, src/views/sessions/sidebar-hover-card-html.ts
import { test, expect, type Page } from "@playwright/test";
import {
  capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance,
} from "./harness";

// The project settings carry no Check a sub's work row (removed 2026-11-13, no
// project used Facts only) and the connectors switch says what it
// is, and a sub held for its project's writer slot reads as queued in the sub list
// and the sidebar hover.
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
  // The compaction row renders last, so its filled size means every row is in.
  await expect(page.locator("#project-config-host #compactK")).not.toHaveValue("");
}

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / project settings rows (${label})`, () => {
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

    test("no sub check row, and the connectors switch carries its explanation inside the rail", async ({ page }) => {
      await mount(page);
      const host = page.locator("#project-config-host");
      await expect(host.locator("#subchatCheckSelect")).toHaveCount(0);
      await expect(host.getByText("Check a sub's work")).toHaveCount(0);
      await expect(host.locator(".ps-group-title", { hasText: "Subchats" })).toHaveCount(0);

      await expect(host.getByLabel("claude.ai connectors")).toHaveCount(1);
      const hint = host.locator(".ps-hint");
      await expect(hint).toBeVisible();
      await expect(hint).toContainText("Google Drive");
      // Nothing spills out of the 270px rail.
      const box = (await host.boundingBox())!;
      const hb = (await hint.boundingBox())!;
      expect(hb.x).toBeGreaterThanOrEqual(box.x);
      expect(hb.x + hb.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      await capture(host, `project-settings-rows-${label}`);
    });

    test("the connectors switch still saves its one field", async ({ page }) => {
      await mount(page);
      await page.locator("#project-config-host label.switch:has(#connectorsEnabled)").click();
      await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "update_project").length).toBe(1);
      const calls = (await invokeCalls(page)).filter((c) => c.cmd === "update_project");
      expect((calls[0]!.args as { patch: unknown }).patch).toEqual({ claude_ai_connectors: true });
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
    test("the sub list shows a sub held for the writer as waiting, in its own Queued group", async ({ page }) => {
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
      // The working sub sits under Running and the queued one under Queued.
      await expect(page.locator(".sub-list-popover .sub-list-head")).toHaveText(["Running", "Queued"]);
      const names = await page.locator(".sub-list-popover .sub-row .sub-name").allTextContents();
      expect(names).toEqual(["Header", "Footer"]);
      await capture(page.locator(".sub-list-popover"), `queued-sub-list-${label}`);
    });
  });
}

test.describe("view-harness / queued sub (desktop hover)", () => {
  test("the main chat's hover card lists the queued sub with the waiting words and a dim dot, not the working yellow", async ({ page }) => {
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
    // The working sub's dot is yellow; a sub that has not started is dim.
    expect(colours[1]).not.toBe(colours[0]);
    // The sidebar shows no red dot for a sub that is only waiting.
    await expect(row.locator(".ask-dot")).toHaveCount(0);
  });
});
