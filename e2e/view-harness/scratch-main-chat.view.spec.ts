// asserts: src/views/sessions/draft-subchats.ts, src/views/sessions/new-chat-config.ts, src/views/sessions/draft-subchats.css, src/views/sessions/pending-pane-composer.ts, src/views/sessions/project-main-chats.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// pc-1806 step 7: a draft in the "No project" folder (the Obsidian vault) is a plain chat. Its one
// way into main-chat mode is the "Send to the scratch main chat" switch, which makes the draft the
// shared scratch main chat, or sends the message into it when one is already open.

const VAULT = "C:/Users/tecno/Documents/ObsidianVault";
const SCRATCH = sessionInstance({ session_id: "scratch-1", name: "Scratch pad", pid: 101, cwd: VAULT, project_id: "p-vault", busy: false, awaiting: "done" });
const POINTED = [{ id: "p-vault", path: VAULT, name: "ObsidianVault", default_model: null, default_effort: null, main_chat_id: "scratch-1" }];
const UNPOINTED = [{ ...POINTED[0], main_chat_id: null }];

function invoke(sessions: unknown[], on: string[], projects: unknown[]) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: on,
    list_projects: projects,
    // A group's dashboard has no settings rail, so the switch is the row above the box.
    dashboard_list_targets: [{
      target: { kind: "group", id: "g-vault", name: "ObsidianVault", repos: [{ cwd: VAULT, name: "ObsidianVault", project_id: null }] },
      last_active_ms: 0, live_count: 0, question_count: 0, working_count: 0,
    }],
    start_session: "real-new",
    send_message: null,
    set_auto_accept: null,
    set_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
    clear_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
    get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    context_status: null,
    list_slash_commands: [],
    list_auto_accept: [],
  };
}

async function openDraft(page: Page, size: { width: number; height: number }, sessions: unknown[], on: string[], projects: unknown[]): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, { view: "sessions", invoke: invoke(sessions, on, projects) });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  // The draft's own config opens plain in the vault, so this is the config `resolveNewChatConfig` hands it.
  await page.evaluate((p) => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: Record<string, unknown>) => void })
      .__launchDraftForTest({ path: p, name: "ObsidianVault" }, { model: "sonnet", effort: "low", accountId: "acc1", subchatsOn: false, plainChat: true });
  }, VAULT);
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
}

const route = (page: Page) => page.locator("#session-pane .draft-main-route");
const useRow = (page: Page) => page.locator("#session-pane .draft-subchats");
const send = async (page: Page, text: string): Promise<void> => {
  await page.locator("#session-pane .session-composer .composer-textarea").fill(text);
  await page.locator("#session-pane .session-composer .composer-send").click();
};
const startArgs = async (page: Page) => (await invokeCalls(page)).find((c) => c.cmd === "start_session")!.args;

for (const [label, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 393, height: 852 }]] as const) {
  test.describe(`view-harness / the scratch main chat switch (${label})`, () => {
    test("the vault draft shows the switch off above the box, with no Use subchats row", async ({ page }) => {
      await openDraft(page, size, [], [], UNPOINTED);
      await expect(route(page)).toBeVisible();
      await expect(route(page).locator(".dmr-switch-label")).toHaveText("Send to the scratch main chat");
      await expect(route(page).locator("input")).not.toBeChecked();
      await expect(route(page).locator(".dmr-line")).toHaveText("A plain chat");
      await expect(useRow(page)).toBeHidden();
      // Sits right above the message box and is never clipped at this width.
      const box = (await route(page).boundingBox())!;
      const boxTop = (await page.locator("#session-pane .composer-shell").boundingBox())!.y;
      expect(box.y + box.height).toBeLessThanOrEqual(boxTop + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      await capture(page.locator("#session-pane"), `scratch-switch-off-${label}`);
    });

    test("left off, the first send starts a plain chat", async ({ page }) => {
      await openDraft(page, size, [], [], UNPOINTED);
      await send(page, "what is the time in Zagreb");
      await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "start_session")).toBe(true);
      expect(await startArgs(page)).toMatchObject({ subchatsOn: false });
      expect((await invokeCalls(page)).some((c) => c.cmd === "send_message")).toBe(false);
    });

    test("with no scratch main chat open, switching on makes the first spawn the main chat", async ({ page }) => {
      await openDraft(page, size, [], [], UNPOINTED);
      await route(page).locator(".slider").click();
      await expect(route(page).locator("input")).toBeChecked();
      await expect(route(page).locator(".dmr-line")).toHaveText("Starts the scratch main chat");
      await capture(page.locator("#session-pane"), `scratch-switch-on-new-${label}`);
      await send(page, "start the scratch pad");
      await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "start_session")).toBe(true);
      expect(await startArgs(page)).toMatchObject({ subchatsOn: true });
    });

    test("with the scratch main chat open, a plain draft starts its own chat and the switch sends the message into it", async ({ page }) => {
      await openDraft(page, size, [SCRATCH], ["scratch-1"], POINTED);
      await expect(route(page).locator(".dmr-line")).toHaveText("A plain chat");
      await expect(route(page).locator("input")).not.toBeChecked();

      await route(page).locator(".slider").click();
      await expect(route(page).locator(".dmr-line")).toHaveText("Goes to Scratch pad");
      await capture(page.locator("#session-pane"), `scratch-switch-on-existing-${label}`);
      await send(page, "add this to the pad");
      await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "send_message")).toBe(true);
      const calls = await invokeCalls(page);
      expect(calls.some((c) => c.cmd === "start_session")).toBe(false);
      expect((calls.find((c) => c.cmd === "send_message")!.args as { sessionId: string }).sessionId).toBe("scratch-1");
    });
  });
}
