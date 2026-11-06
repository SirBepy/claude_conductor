// asserts: src/views/sessions/draft-subchats.ts, src/views/sessions/pending-pane.ts, src/views/sessions/pending-pane-composer.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A new-chat draft carries the "Use subchats" choice: the switch sits above the
// message box, moves the chip to Opus, and the first start_session RPC carries
// the flag so the first spawn is already a main chat.

const REAL = "real-main";
const CWD = "C:/Projects/alpha";

async function openDraft(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [],
      get_active_sessions: [],
      list_subchats_on: [],
      start_session: REAL,
      set_auto_accept: null,
      set_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
      clear_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      context_status: null,
      list_slash_commands: [],
      send_message: null,
      list_auto_accept: [],
    },
  });
  await page.evaluate(({ real, row }) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } };
      __rows: unknown[];
      __ccInvokeCalls: Array<{ cmd: string; args?: unknown }>;
    };
    w.__rows = [];
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === "list_instances" || cmd === "get_active_sessions") return Promise.resolve(w.__rows);
      if (cmd === "start_session") {
        w.__ccInvokeCalls.push({ cmd, args });
        w.__rows = [row];
        return Promise.resolve(real);
      }
      return orig(cmd, args);
    };
  }, { real: REAL, row: sessionInstance({ session_id: REAL, name: "New chat", cwd: CWD, pid: 200, model: "opus", effort: "high", busy: false, awaiting: "done" }) });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate(() => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: { model: string; effort: string; accountId: string }) => void })
      .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "low", accountId: "acc1" });
  });
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
}

const row = (page: Page) => page.locator("#session-pane .draft-subchats");
const sw = (page: Page) => row(page).locator(".slider");
const modelText = (page: Page) => page.locator("#session-pane .session-header .meta-cfg-model-text");

for (const [label, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 393, height: 852 }]] as const) {
  test.describe(`view-harness / Use subchats on a new-chat draft (${label})`, () => {
    test("the switch sits right above the message box, off by default", async ({ page }) => {
      await openDraft(page, size);
      await expect(row(page)).toBeVisible();
      await expect(row(page).locator("input")).not.toBeChecked();
      const rowBox = (await row(page).boundingBox())!;
      const boxTop = (await page.locator("#session-pane .composer-shell").boundingBox())!.y;
      expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(boxTop + 1);
    });

    test("switching it on moves the chip to Opus, and the first send carries the flag", async ({ page }) => {
      await openDraft(page, size);
      await expect(modelText(page)).toHaveText(/Sonnet/);
      await sw(page).click();
      await expect(row(page).locator("input")).toBeChecked();
      await expect(modelText(page)).toHaveText(/Opus/);
      await capture(page.locator("#session-pane"), `draft-subchats-on-${label}`);

      await page.locator("#session-pane .session-composer .composer-textarea").fill("build the site");
      await page.locator("#session-pane .session-composer .composer-send").click();
      await page.waitForFunction(() => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls.some((c) => c.cmd === "start_session"));
      const args = await page.evaluate(() =>
        (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__ccInvokeCalls.find((c) => c.cmd === "start_session")!.args);
      expect(args).toMatchObject({ subchatsOn: true, model: "opus", effort: "high" });
      // The row is gone once the draft became the chat.
      await expect(row(page)).toHaveCount(0);
    });

    test("left off, the first send starts an ordinary chat", async ({ page }) => {
      await openDraft(page, size);
      await page.locator("#session-pane .session-composer .composer-textarea").fill("quick question");
      await page.locator("#session-pane .session-composer .composer-send").click();
      await page.waitForFunction(() => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls.some((c) => c.cmd === "start_session"));
      const args = await page.evaluate(() =>
        (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__ccInvokeCalls.find((c) => c.cmd === "start_session")!.args);
      expect(args).toMatchObject({ subchatsOn: false, model: "sonnet", effort: "low" });
    });
  });
}
