import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Todo 799: nobody has seen `ChatRenderer.markLastUserSendFailed`
// (chat-renderer.ts:615) rendered with real CSS - jsdom coverage
// (tests/chat-failed-send-bubble.test.mjs) asserts classes only. Forces the
// failure by making send_message reject once, then screenshots the bubble.

async function mountChatRejectingOnce(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      list_slash_commands: [],
      send_message: null,
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator(".session-composer .composer-textarea").waitFor();

  // First send_message call rejects, every call after succeeds - Retry must
  // re-fire the same command, not a different recovery path.
  await page.evaluate(() => {
    const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
    const passthrough = tauri.core.invoke;
    let failed = false;
    tauri.core.invoke = (cmd: string, args: any) => {
      if (cmd === "send_message" && !failed) {
        failed = true;
        return Promise.reject(new Error("daemon client not connected"));
      }
      return passthrough(cmd, args);
    };
  });
}

async function sendText(page: Page, text: string): Promise<void> {
  const textarea = page.locator(".session-composer .composer-textarea");
  await textarea.fill(text);
  await page.locator(".session-composer .composer-send").click();
}

test("a failed send renders the danger-tinted bubble and Retry re-fires send_message", async ({ page }) => {
  await mountChatRejectingOnce(page);
  await sendText(page, "do not lose this");

  const bubble = page.locator(".msg.user").last();
  await expect(bubble).toHaveClass(/send-failed/);
  await expect(bubble).toContainText("do not lose this");
  await expect(bubble.locator(".failed-chip")).toHaveAttribute("title", /daemon client not connected/);

  const retryBtn = bubble.locator(".api-retry-btn");
  await expect(retryBtn).toBeVisible();

  await capture(page, "chat-failed-send-bubble-short", { fullPage: false });

  await retryBtn.click();
  await expect(bubble).not.toHaveClass(/send-failed/);
  await expect(page.locator(".send-failed-strip")).toHaveCount(0);

  const calls = await page.evaluate(
    () => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls,
  );
  const sendCalls = calls.filter((c) => c.cmd === "send_message");
  expect(sendCalls.length).toBe(2);
});

test("a multi-line failed send keeps the strip clear of the bubble's own text", async ({ page }) => {
  await mountChatRejectingOnce(page);
  const longText = [
    "Here is a longer message that wraps across several lines,",
    "so the failed-send strip has to sit below real body text",
    "instead of a single short line.",
    "- first point",
    "- second point",
  ].join("\n");
  await sendText(page, longText);

  const bubble = page.locator(".msg.user.send-failed");
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("first point");

  const strip = bubble.locator(".send-failed-strip");
  await expect(strip).toBeVisible();

  const stripBox = (await strip.boundingBox())!;
  const bubbleBox = (await bubble.boundingBox())!;
  // The strip must sit inside the bubble's own box, below the wrapped text -
  // never clipped off the bottom or overlapping the message content.
  expect(stripBox.y).toBeGreaterThan(bubbleBox.y);
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(bubbleBox.y + bubbleBox.height + 1);

  await capture(page, "chat-failed-send-bubble-multiline", { fullPage: false });
});
