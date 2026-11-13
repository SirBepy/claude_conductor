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
