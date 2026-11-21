// Reviewed 2026-11-21 (Run card and opened sub view tabs): chat-dashboard.ts, dashboard-zones.ts, dashboard-extras.css and subs-card.ts changed for the Run card's after names and the sub view's Plan and Attachments tabs; nothing this spec asserts changed, and it passes (run of every dependent spec).
// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-17: the chat dashboard's Finished subchats tray became the Done card (one row per task); nothing this spec asserts changed, and it passes (run of every dependent spec).
// Reviewed 2026-11-17 (chat heads replace the sidemenu, pc-1769): what this spec asserts holds with the heads in place of the chat list (at most it clicks a chat to open it), and it passes in the full view-harness run after the change.
// Reviewed 2026-11-15: the chat dashboard gained an Autopilot picks zone that draws only once a chat recorded a pick; nothing this spec asserts changed, and it passes (full run of the dependent specs).
// Reviewed 2026-11-14 (pc-1745, the Links and files card is a tabbed, scrollable list of rows with its tab kept in the dashboard's own state): nothing this spec asserts changed; run after the change and it passes.
// Reviewed 2026-11-14 (pc-1744, the palette's per-project New chat in rows and their startNewSessionInProject/startNewChatInProject helpers are removed): nothing this spec asserts changed; run after the change and it passes.
// Reviewed 2026-11-14 (Result card, finished tray): the Result is its own card under Plan, finished subs sit in a tray under it and the From subs card is gone; nothing this spec asserts changed, and it passes.
// asserts: src/shared/shortcuts.ts, src/views/sessions/sessions-dom-wiring.ts, src/views/sessions/chat-dashboard/chat-view-pref.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/command-palette/sources.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The dashboard is still rough, so Joe wants a fast way out of it from the chat
// window itself (2026-11-13): a "Toggle Dashboard / Messages" row in the Ctrl+Shift+P
// palette. It flips the same app-wide Chat view setting as Settings > Chat
// defaults, and the open chat redraws in place, with no reopen.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "add trello as a tracker" }], timestamp: 0 },
  { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { kind: "answer", verdict: "Yes", text: "Trello can sit next to Shortcut." }, id: "t1", timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
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
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

async function runToggle(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+P");
  await page.locator(".cp-overlay .cp-input").fill("toggle dashboard");
  await expect(page.locator(".cp-row .cp-title").first()).toHaveText("Toggle Dashboard / Messages");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cp-overlay")).toHaveCount(0);
}

const dash = (page: Page) => page.locator("#session-pane .cdash");
const transcript = (page: Page) => page.locator("#session-pane .session-messages");

test("the palette flips the open chat between Dashboard and Messages in place", async ({ page }) => {
  await openChat(page);
  await expect(dash(page)).toBeVisible();
  await expect(transcript(page)).toBeHidden();

  await runToggle(page);
  await expect(dash(page)).toHaveCount(0);
  await expect(transcript(page)).toBeVisible();
  await expect(transcript(page)).toContainText("Trello can sit next to Shortcut.");
  const saved = (await invokeCalls(page)).filter((c) => c.cmd === "save_settings");
  // updateSettings saves through save_settings({ updated }) (settings-update.ts).
  const last = saved[saved.length - 1]?.args as { updated?: Record<string, unknown> } | undefined;
  expect(last?.updated?.chatView).toBe("messages");
  await capture(page.locator("#session-pane"), "chat-view-toggle-messages");

  // And back: the toggle reads the view in force, so a second run restores the dashboard.
  await runToggle(page);
  await expect(dash(page)).toBeVisible();
  await expect(transcript(page)).toBeHidden();
});
