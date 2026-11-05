// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/session-controls.ts, src/views/sessions/subchat-view.ts, src/shared/chat/builtins/clear.ts, src/views/sessions/close-chat.ts, src/views/sessions/chat-menu.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg, assistantMsg } from "./harness";

// Leaving a sub's view must not end the sub. Ctrl+W goes back to the main chat and
// closes nothing, `/clear` is refused with a toast naming why (a sub's job is its
// brief), `/clear` on a main chat with a sub running starts no new chat under the
// daemon's close-approval card, and the header menu's Close still ends a sub on
// purpose. Drives the real sessions view at desktop and phone width.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };
const CWD = "C:/Projects/cv-site";

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) => sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const MAIN = chat("main", "CV redesign", 101);
const FOOTER = chat("sub-footer", "Footer", 102, { subchat_of: "main", busy: false, awaiting: null });
const PLAIN = chat("plain", "Plain chat", 110);

function history(sessionId: string): unknown {
  const events = [userMsg(`ask for ${sessionId}`), assistantMsg(`${sessionId} says hello`)];
  return { events, oldest_seq: 0, newest_seq: events.length, has_more: false };
}

async function mount(page: Page, size: { width: number; height: number }, sessions: unknown[], clearResult: boolean): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: sessions,
      get_active_sessions: sessions,
      list_subchats_on: ["main"],
      list_pending_prompts: [],
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: history("main"),
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      list_slash_commands: [],
      list_auto_accept: [],
      confirm_question_rendered: null,
      send_message: null,
      cancel_turn: null,
      clear_session: clearResult,
    },
  });
  await page.evaluate((hist) => {
    const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
    const orig = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: any) =>
      cmd === "load_history_page" ? Promise.resolve((hist as Record<string, unknown>)[args?.sessionId] ?? (hist as Record<string, unknown>).main) : orig(cmd, args);
  }, { main: history("main"), "sub-footer": history("sub-footer"), plain: history("plain") });
  await page.locator("#sessions-list li").first().waitFor();
  await page.waitForTimeout(250);
}

const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const title = (page: Page) => page.locator("#session-pane .session-header .title");
const backBtn = (page: Page) => page.locator("#session-pane .session-header .sub-back-btn");
const input = (page: Page) => page.locator(".session-composer .cc-typing-input");

async function openChat(page: Page, id: string, name: string): Promise<void> {
  await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
  await row(page, id).click();
  await expect(title(page)).toHaveText(name);
  await input(page).waitFor({ state: "attached" });
}

async function openFooter(page: Page): Promise<void> {
  await openChat(page, "main", "CV redesign");
  await page.locator("#session-pane .session-header .sub-count-btn").click();
  await page.locator('.sub-list-popover .sub-row[data-sub-id="sub-footer"]').click();
  await expect(backBtn(page)).toBeVisible();
  await expect(title(page)).toHaveText("Footer");
}

const calls = async (page: Page, cmd: string) => (await invokeCalls(page)).filter((c) => c.cmd === cmd);

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / leaving a sub's view (${label})`, () => {
    test("Ctrl+W goes back to the main chat and closes nothing", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER], false);
      await openFooter(page);
      await page.keyboard.press("Control+w");
      await expect(title(page)).toHaveText("CV redesign");
      await expect(backBtn(page)).toHaveCount(0);
      // No confirm dialog, no close, and the sub is still a sub of the main chat.
      await expect(page.locator(".confirm-dialog, .cc-confirm, [role=dialog]")).toHaveCount(0);
      expect(await calls(page, "clear_session")).toEqual([]);
      expect(await calls(page, "cancel_turn")).toEqual([]);
      await capture(page, `sub-ctrl-w-back-${label}`);
    });

    test("Ctrl+W on an ordinary chat still asks to close it", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, PLAIN], false);
      await openChat(page, "plain", "Plain chat");
      await page.keyboard.press("Control+w");
      await expect(page.getByText("Close this chat?")).toBeVisible();
      expect(await calls(page, "clear_session")).toEqual([]);
    });

    test("/clear typed in a sub's view is refused with a toast and ends nothing", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER], false);
      await openFooter(page);
      await input(page).fill("/clear");
      await page.locator(".session-composer .composer-send").click();
      await expect(page.locator(".toast")).toContainText("defined by its brief");
      expect(await calls(page, "clear_session")).toEqual([]);
      expect(await calls(page, "start_session")).toEqual([]);
      // Still the sub, with its back arrow: nothing replaced the pane.
      await expect(title(page)).toHaveText("Footer");
      await expect(backBtn(page)).toBeVisible();
      await capture(page, `sub-clear-refused-${label}`);
    });

    test("/clear on a main chat whose sub is running starts no new chat while the daemon holds the close", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER], true);
      await openChat(page, "main", "CV redesign");
      await input(page).fill("/clear");
      await page.locator(".session-composer .composer-send").click();
      await expect.poll(async () => (await calls(page, "clear_session")).length).toBe(1);
      await page.waitForTimeout(500);
      expect(await calls(page, "start_session")).toEqual([]);
      await expect(title(page)).toHaveText("CV redesign");
      await expect(row(page, "main")).toHaveCount(1);
    });

    test("the header menu's Close still ends a sub on purpose", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER], false);
      await openFooter(page);
      // The open chat's own menu: the explicit way to close it.
      await page.locator("#viewMoreBtn").click();
      await page.locator(".view-more-menu .smore-item.smore-danger", { hasText: "Close session" }).click();
      await expect.poll(async () => (await calls(page, "clear_session")).length).toBe(1);
      expect((await calls(page, "clear_session"))[0]!.args).toMatchObject({ sessionId: "sub-footer" });
    });
  });
}
