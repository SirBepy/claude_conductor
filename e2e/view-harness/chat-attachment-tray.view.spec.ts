import { test, expect, type Page } from "@playwright/test";
import { assistantMsg, capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// A long user message with attachments: the text clamps behind "Show more",
// and the sent attachments sit in a slim tray UNDER the bubble instead of
// being clipped inside it. Images past 6 fold into one "+N" tile.
// asserts: src/shared/chat/message-attachment-tray.ts, src/shared/chat/chat-messages-user.css, src/shared/chat/turn-collapse.ts

const LONG = Array.from(
  { length: 7 },
  (_, i) => `Point ${i + 1}: the splash holds for almost two seconds even when the daemon is already up, which feels like a bug rather than a choice, and the pairing screen jumps when the keyboard opens.`,
).join("\n\n");
const TOKENS = Array.from({ length: 8 }, (_, i) => `<file:C:/shots/step-${i + 1}.png::step-${i + 1}.png>`).join("\n");

async function mountChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 900 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: {
        events: [assistantMsg("Send over whatever you have."), userMsg(`${LONG}\n\n${TOKENS}`), assistantMsg("Got it.")],
        oldest_seq: 0,
        newest_seq: 0,
        has_more: false,
      },
      read_attachment: null,
    },
  });
  // A distinct PNG per path: the thumb click resolves its gallery slot by
  // matching bytes, so identical images would all open at the first one.
  await page.evaluate(() => {
    const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
    const passthrough = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: { path?: string }) => {
      if (cmd !== "read_attachment") return passthrough(cmd, args);
      const n = Number(/step-(\d+)/.exec(args.path ?? "")?.[1] ?? 0);
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 160;
      const g = c.getContext("2d")!;
      g.fillStyle = `hsl(${n * 40}, 70%, 50%)`;
      g.fillRect(0, 0, 160, 160);
      return Promise.resolve({ mime: "image/png", base64: c.toDataURL("image/png").split(",")[1] });
    };
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .msg.user .msg-tray .sent-attachment-thumb").first().waitFor();
}

test("attachments sit in a tray under the clamped bubble, 6 shown and the rest folded into +N", async ({ page }) => {
  await mountChat(page);
  const msg = page.locator("#session-pane .msg.user").first();
  const bubble = msg.locator(":scope > .msg-bubble");
  const tray = msg.locator(":scope > .msg-tray");

  await expect(msg.locator(".msg-clamp-toggle")).toHaveText("Show more");
  await expect(tray.locator(".sent-attachment-thumb")).toHaveCount(8);
  await expect(tray.locator(".sent-attachment-thumb:visible")).toHaveCount(6);
  await expect(tray.locator(".msg-tray-more")).toHaveText("+2");

  // The tray is below the bubble and outside the clipped text body.
  const b = (await bubble.boundingBox())!;
  const t = (await tray.boundingBox())!;
  expect(t.y).toBeGreaterThanOrEqual(b.y + b.height);
  await expect(tray.locator(".sent-attachment-thumb:visible").first()).toBeVisible();

  // The wrapper is transparent and the bubble carries the look.
  const wrapperBg = await msg.evaluate((e) => getComputedStyle(e).backgroundColor);
  const bubbleBg = await bubble.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(wrapperBg).toBe("rgba(0, 0, 0, 0)");
  expect(bubbleBg).not.toBe("rgba(0, 0, 0, 0)");

  await capture(page, "chat-attachment-tray", { fullPage: false });
});

test("+N opens the chat image gallery at the first folded image", async ({ page }) => {
  await mountChat(page);
  await page.locator("#session-pane .msg.user .msg-tray-more").click();
  await expect(page.locator(".chat-image-gallery-overlay")).toBeVisible();
  await expect(page.locator(".gallery-total-counter")).toHaveText("7 of 8");
});
