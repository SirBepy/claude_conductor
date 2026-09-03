import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Todo 825: live-verifies active-session-mount.ts's 8s stall guard
// (mountRenderer, ~226-245). ai_todo 228 established the guard times a purely
// local chain - sessionEvents.loadInitial's `load_history_page` read - not the
// daemon pipe, so stalling that one command is enough to trip it.

const TRANSCRIPT = { events: [], oldest_seq: 0, newest_seq: 0, has_more: false };

async function mountChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      list_slash_commands: [],
      get_skipped_question_marks: [],
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

/** Overrides `load_history_page`: the first call never resolves (reproducing
 *  a wedged local read); every call after resolves normally, so clicking
 *  Retry (which re-runs mountRenderer, hence loadInitial) recovers. */
async function stallFirstHistoryLoad(page: Page): Promise<void> {
  await page.evaluate((transcript) => {
    const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
    const passthrough = tauri.core.invoke;
    let calls = 0;
    tauri.core.invoke = (cmd: string, args: any) => {
      if (cmd === "load_history_page") {
        calls += 1;
        return calls === 1 ? new Promise(() => { /* never resolves */ }) : Promise.resolve(transcript);
      }
      return passthrough(cmd, args);
    };
  }, TRANSCRIPT);
}

test.describe("view-harness / chat-open stall guard", () => {
  test("a wedged local history read shows the stall screen with a working Retry", async ({ page }) => {
    test.setTimeout(600000);
    await mountChat(page);
    await stallFirstHistoryLoad(page);

    await page.locator("#sessions-list li[data-session-id]").first().click();

    const stalled = page.locator(".chat-load-stalled");
    await expect(stalled).toBeVisible({ timeout: 600000 });
    await expect(stalled).toContainText("didn't respond");

    const retryBtn = stalled.locator(".chat-load-retry");
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    await expect(page.locator(".chat-load-stalled")).toHaveCount(0);
    await expect(page.locator("#session-pane .session-messages")).toBeVisible();
  });

  test("a healthy mount never flashes the stall screen", async ({ page }) => {
    await mountChat(page);
    await page.evaluate((transcript) => {
      const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) =>
        cmd === "load_history_page" ? Promise.resolve(transcript) : passthrough(cmd, args);
    }, TRANSCRIPT);

    await page.locator("#sessions-list li[data-session-id]").first().click();
    await page.locator("#session-pane .session-messages").waitFor();

    await expect(page.locator(".chat-load-stalled")).toHaveCount(0);
    await expect(page.locator(".chat-loading-overlay")).toHaveCount(0);
  });
});
