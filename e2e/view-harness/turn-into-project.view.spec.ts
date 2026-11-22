// asserts: src/views/sessions/turn-into-project.ts, src/views/sessions/turn-into-project-model.ts, src/views/sessions/turn-into-project.css, src/views/sessions/chat-menu-items.ts, src/views/command-palette/sources.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, openPaletteFor, paletteRow, SESSIONS_BASE_INVOKE, sessionInstance, userMsg, assistantMsg } from "./harness";

// "Turn into a project" (pc-1806 step 8): a chat in the No project folder offers it in its menu (the
// palette carries the same rows), the dialog asks for a folder, shows what moves and what stays behind,
// and calls promote_to_project with the chat and the folder. A project chat is never offered it.

const VAULT = "C:/Users/joe/Documents/ObsidianVault";
const SCRATCH = sessionInstance({ session_id: "scratch", name: "Loose ideas", pid: 101, cwd: VAULT });
const PROJECT_CHAT = sessionInstance({ session_id: "proj", name: "CV chat", pid: 102, cwd: "C:/Projects/cv-site", project_id: "p1" });

const PREVIEW = {
  moved: { subs: 2, remote_subs: 0, cards: 1 },
  forks: true,
  stays_behind: ["Each sub keeps its own folder and worktree", "This chat ends here and shows in History"],
};

async function mountChat(page: Page, openId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const sessions = [SCRATCH, PROJECT_CHAT];
  await page.setViewportSize({ width: 1280, height: 800 });
  const events = [userMsg("an idea"), assistantMsg("a reply")];
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: sessions,
      get_active_sessions: sessions,
      list_subchats_on: [],
      list_pending_prompts: [],
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      list_slash_commands: [],
      list_auto_accept: [],
      confirm_question_rendered: null,
      promote_preview: PREVIEW,
      pick_folder: "C:/Projects/ideas-shop",
      promote_to_project: {
        ok: true,
        result: { project_id: "p9", project_path: "C:/Projects/ideas-shop", successor_id: "new", forked: true, moved: PREVIEW.moved, stays_behind: PREVIEW.stays_behind },
      },
      ...extra,
    },
  });
  await page.locator("#sessions-list li").first().waitFor();
  await page.locator(`#sessions-list li[data-session-id="${openId}"]`).click();
  await page.locator(".session-composer .cc-typing-input").waitFor({ state: "attached" });
}

const dialog = (page: Page) => page.locator("[data-turn-into-project]");
const calls = async (page: Page, cmd: string) => (await invokeCalls(page)).filter((c) => c.cmd === cmd);

test("a No project chat's menu offers Turn into a project, and the dialog lists what moves and what stays", async ({ page }) => {
  await mountChat(page, "scratch");
  await openPaletteFor(page, "Turn into a project");
  await paletteRow(page, "Turn into a project").click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator("[data-tip-moves]")).toContainText("2 subs");
  await expect(dialog(page).locator("[data-tip-moves]")).toContainText("1 sub card");
  await expect(dialog(page).locator("[data-tip-stays]")).toContainText("Each sub keeps its own folder and worktree");
  await expect(dialog(page).locator("[data-tip-go]")).toBeDisabled();
  expect(await calls(page, "promote_preview")).toEqual([{ cmd: "promote_preview", args: { sessionId: "scratch" } }]);
  await capture(page, "turn-into-project-no-folder");
});

test("choosing a folder enables the button, and going calls promote_to_project with the chat and the folder", async ({ page }) => {
  await mountChat(page, "scratch");
  await openPaletteFor(page, "Turn into a project");
  await paletteRow(page, "Turn into a project").click();
  await dialog(page).locator("[data-tip-choose]").click();
  await expect(dialog(page).locator("[data-tip-path]")).toHaveText("C:/Projects/ideas-shop");
  await expect(dialog(page).locator("[data-tip-go]")).toBeEnabled();
  await capture(page, "turn-into-project-folder-chosen");
  await dialog(page).locator("[data-tip-go]").click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await calls(page, "promote_to_project")).toEqual([
    { cmd: "promote_to_project", args: { sessionId: "scratch", path: "C:/Projects/ideas-shop" } },
  ]);
});

test("a refusal from the daemon stays in the dialog, shown in place, and the dialog stays open", async ({ page }) => {
  await mountChat(page, "scratch");
  await page.evaluate(() => {
    const core = (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } }).__TAURI__.core;
    const original = core.invoke;
    core.invoke = (cmd, args) => (cmd === "promote_to_project" ? Promise.reject(new Error("The folder is a temp folder")) : original(cmd, args));
  });
  await openPaletteFor(page, "Turn into a project");
  await paletteRow(page, "Turn into a project").click();
  await dialog(page).locator("[data-tip-choose]").click();
  await dialog(page).locator("[data-tip-go]").click();
  await expect(dialog(page).locator("[data-tip-error]")).toContainText("The folder is a temp folder");
  await expect(dialog(page).locator("[data-tip-go]")).toBeEnabled();
  await capture(page, "turn-into-project-refused");
});

test("a project chat's menu has no Turn into a project", async ({ page }) => {
  await mountChat(page, "proj");
  await openPaletteFor(page, "Turn into a project");
  await expect(paletteRow(page, "Turn into a project")).toHaveCount(0);
});
