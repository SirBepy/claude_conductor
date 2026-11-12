// Reviewed 2026-11-12: closeChat now resolves true or false instead of nothing and its callers ignore it; nothing this spec asserts changed (not run here).
// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome): nothing this spec asserts changed. It passes.
// asserts: src/views/sessions/chat-menu-items.ts, src/views/command-palette/sources.ts, src/views/settings/subviews/chat-defaults/chat-defaults.ts, src/views/sessions/project-dashboard/project-config/rows.ts, src/views/sessions/project-dashboard/project-config/project-settings.ts, src/shared/auto-compact.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, openPaletteFor, paletteRow, SESSIONS_BASE_INVOKE, sessionInstance, userMsg, assistantMsg } from "./harness";

// "Compact now" sits in the chat menu (the palette carries the same rows) for a
// main chat only, and the compaction setting lives in Settings > Chat defaults
// and the project's config page. Unit tests cover the logic; this drives the
// real menu and pages.

const CWD = "C:/Projects/cv-site";
const MAIN = sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: CWD });
const PLAIN = sessionInstance({ session_id: "plain", name: "Plain chat", pid: 110, cwd: CWD });

function history(id: string): unknown {
  const events = [userMsg(`ask for ${id}`), assistantMsg(`${id} says hello`)];
  return { events, oldest_seq: 0, newest_seq: events.length, has_more: false };
}

async function mountChat(page: Page, openId: string): Promise<void> {
  const sessions = [MAIN, PLAIN];
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: sessions,
      get_active_sessions: sessions,
      list_subchats_on: ["main"],
      list_pending_prompts: [],
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: history(openId),
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      list_slash_commands: [],
      list_auto_accept: [],
      confirm_question_rendered: null,
      compact_now: { ok: true },
    },
  });
  await page.locator("#sessions-list li").first().waitFor();
  await page.locator(`#sessions-list li[data-session-id="${openId}"]`).click();
  await expect(page.locator("#session-pane .session-header .title")).toHaveText(openId === "main" ? "CV redesign" : "Plain chat");
  await page.locator(".session-composer .cc-typing-input").waitFor({ state: "attached" });
}

test("a main chat's menu has Compact now and running it calls compact_now", async ({ page }) => {
  await mountChat(page, "main");
  await openPaletteFor(page, "Compact now");
  const row = paletteRow(page, "Compact now");
  await expect(row).toBeVisible();
  await capture(page, "compact-now-palette-main-chat");
  await row.click();
  await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "compact_now")).toEqual([
    { cmd: "compact_now", args: { sessionId: "main" } },
  ]);
});

test("a plain chat's Compact now is greyed out with its reason and calls nothing", async ({ page }) => {
  await mountChat(page, "plain");
  await openPaletteFor(page, "Compact now");
  const row = paletteRow(page, "Compact now");
  await expect(row).toBeVisible();
  await expect(row).toContainText("main chat");
  await row.click({ force: true });
  expect((await invokeCalls(page)).filter((c) => c.cmd === "compact_now")).toEqual([]);
});

test("the project's config page shows the compaction switch and size in force", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 1100 });
  const cwd = "C:/work/demo";
  await mountView(page, {
    view: "settings-appearance",
    invoke: {
      list_accounts: [],
      resolve_project_account: null,
      get_ticket_tracker: null,
      list_projects: [{ id: "p1", path: cwd }],
      get_settings: { autoCompact: { tokens: 400000, projects: { p1: { on: false } } } },
    },
  });
  await page.locator(".kit-row").first().waitFor();
  await page.evaluate(async (projectCwd) => {
    const { renderProjectSettings } = await import("/views/sessions/project-dashboard/project-config/project-settings.ts");
    const host = document.createElement("div");
    host.id = "project-config-host";
    host.style.width = "270px";
    document.body.appendChild(host);
    await renderProjectSettings(host, projectCwd);
  }, cwd);
  await page.locator("#project-config-host #chatDefaultModelControl .vs").waitFor({ state: "visible" });
  await expect(page.locator("#compactOn")).not.toBeChecked();
  await expect(page.locator("#compactK")).toHaveValue("400");
  await capture(page.locator("#project-config-host"), "compaction-project-settings");
});

test("Settings > Chat defaults shows the compaction switch and size", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1000 });
  await mountView(page, { view: "settings-chat-defaults", invoke: { get_settings: { autoCompact: { tokens: 350000 } } } });
  await page.locator(".view-settings-chat-defaults").waitFor();
  await expect(page.locator("#chatDefaultsCompactOn")).toBeChecked();
  await expect(page.locator("#chatDefaultsCompactK")).toHaveValue("350");
  await capture(page.locator(".view-settings-chat-defaults"), "compaction-chat-defaults");
});
