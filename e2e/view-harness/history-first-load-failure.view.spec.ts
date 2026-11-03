import { test, expect, type Page } from "@playwright/test";
// asserts: src/shared/chat/event-store-pagination.ts, src/shared/chat/chat-pagination.ts
import { assistantMsg, mountSessionsList, sessionInstance, userMsg } from "./harness";

// Todo 1122: a chat opened before its transcript exists (a /respawn successor
// is selected the moment it spawns) gets a failed first history load. That
// failure must not be remembered as "nothing older": reopening the chat once
// the transcript is there has to offer older history again.

const A = sessionInstance({ session_id: "succ", pid: 101, name: "Successor" });
const B = sessionInstance({ session_id: "other", pid: 102, name: "Other chat" });

const PAGE = {
  events: Array.from({ length: 10 }, (_, i) => [userMsg(`q${i}`), assistantMsg(`a${i}`)]).flat(),
  oldest_seq: 40,
  newest_seq: 60,
  has_more: true,
  continues_from: null,
};

/** First load_history_page for `succ` rejects (no JSONL yet), later ones answer. */
async function transcriptAppearsLate(page: Page): Promise<void> {
  await page.addInitScript((pageData) => {
    let succCalls = 0;
    let tauri: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } | undefined;
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      get: () => tauri,
      set: (v) => {
        const real = v.core.invoke;
        v.core.invoke = (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "load_history_page") {
            if (args?.sessionId !== "succ") {
              return Promise.resolve({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false, continues_from: null });
            }
            succCalls++;
            return succCalls === 1 ? Promise.reject(new Error("transcript not found")) : Promise.resolve(pageData);
          }
          return real(cmd, args);
        };
        tauri = v;
      },
    });
  }, PAGE);
}

test("a failed first history load is retried when the chat is reopened", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await transcriptAppearsLate(page);
  await mountSessionsList(page, [A, B], { list_slash_commands: [], get_git_dirty: null });

  const row = (id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
  await row("succ").click();
  await page.waitForTimeout(500);
  await row("other").click();
  await page.waitForTimeout(500);
  await row("succ").click();

  await expect(page.locator("#session-pane .chat-top-sentinel")).toHaveCount(1);
});
