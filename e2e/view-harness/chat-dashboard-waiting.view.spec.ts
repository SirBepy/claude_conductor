// Reviewed 2026-11-14 (Result card, finished tray): the Result is its own card under Plan, finished subs sit in a tray under it and the From subs card is gone; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-13 (From subs): the dashboard gained a From subs zone in the left column that draws sub reports which are not answers; nothing this spec asserts changed, and it passes.
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/chat-dashboard/waiting-dismissed.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Waiting on you holds only blockers that still stand (Joe, 2026-11-13: three
// stale BLOCKED cards of an iOS build chat, "i hate how easy it is for outdated
// info to just stick... i cant even see when this is written, nor can i remove
// it"). A newer blocker on the same thing replaces an older one even when Joe
// never wrote in between (that chat was driven by relayed messages), each card
// says when it was written, and its x on hover (or Clear all) removes it.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";
// 2026-11-01 18:40 UTC in seconds, as history rows carry it: not today, so the day shows.
const WRITTEN = 1793558400;

let n = 0;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`) => [
  { type: "tool_use", tool_name, input, id, timestamp: WRITTEN, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: WRITTEN },
];
const user = (text: string, author?: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: WRITTEN, ...(author ? { author_session_id: author } : {}) });

const IOS_CHAT = [
  user("build the ipa and upload it"),
  ...tool(SEND, { kind: "blocker", verdict: "Bundle checksum mismatch, stopped", text: "The decoded bundle is 10728 bytes but its sha256 is wrong." }),
  user("here is a fresh bundle", "pc-chat"),
  ...tool(SEND, { kind: "blocker", verdict: "Commits pulled, build blocked by hook", text: "A hook blocks every flutter command from Bash." }),
  ...tool(SEND, { kind: "do_this", verdict: "Allow flutter in the hook", text: "Add flutter to the allowed commands." }),
  ...tool(SEND, { kind: "blocker", verdict: "ipa build failed, nothing uploaded", text: "`flutter build ipa` fails at archive." }),
];

async function openChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: IOS_CHAT, oldest_seq: 0, newest_seq: IOS_CHAT.length, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const waiting = (page: Page) => page.locator("#session-pane .cdash .cdash-waiting");

test.describe("chat dashboard Waiting on you", () => {
  test("keeps only the blocker that still stands, says when it was written, and removes cards on request", async ({ page }) => {
    await openChat(page);
    const w = waiting(page);
    // The two older blockers were replaced by the newest one; the to-do stays.
    await expect(w.locator(".mc-verdict")).toHaveText(["ipa build failed, nothing uploaded", "Allow flutter in the hook"]);

    // Each card says when it was written, with the day since it is not today.
    const at = w.locator(".cdash-wi").first().locator(".cdash-wi-at");
    const expected = await page.evaluate((s) => {
      const d = new Date(s * 1000);
      return [d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })];
    }, WRITTEN);
    await expect(at).toContainText(expected[0]!);
    await expect(at).toContainText(expected[1]!);

    // The x and Clear all show only on hover.
    const x = w.locator(".cdash-wi").first().locator("[data-act='wait-dismiss']");
    const clear = w.locator("[data-act='wait-clear']");
    await page.mouse.move(5, 5);
    await expect(x).toHaveCSS("opacity", "0");
    await expect(clear).toHaveCSS("opacity", "0");
    await w.locator(".cdash-wi").first().hover();
    await expect(x).toHaveCSS("opacity", "1");
    await expect(clear).toHaveCSS("opacity", "1");
    await capture(w, "waiting-hover");

    await x.click();
    await expect(w.locator(".mc-verdict")).toHaveText(["Allow flutter in the hook"]);
    // One card left: its own x does what Clear all would.
    await expect(clear).toHaveCount(0);
    await w.locator(".cdash-wi [data-act='wait-dismiss']").click();
    await expect(waiting(page)).toHaveCount(0);
  });

  test("Clear all removes every blocker and to-do at once, and the removal survives a reload", async ({ page }) => {
    await openChat(page);
    const w = waiting(page);
    await expect(w.locator(".cdash-wi")).toHaveCount(2);
    await w.hover();
    await w.locator("[data-act='wait-clear']").click();
    await expect(waiting(page)).toHaveCount(0);
    await page.reload();
    await openChat(page);
    // The dashboard is drawn again (the Plan card always is), still without them.
    await expect(page.locator("#session-pane .cdash .cdash-plan")).toBeVisible();
    await expect(waiting(page)).toHaveCount(0);
  });
});
