// asserts: src/shared/chat/drill-links.ts, src/shared/chat/chat-renderer.ts, src/shared/chat/chat-message-card.ts, src/views/sessions/subchat-view.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// pc-1705 item 3: Joe could not click `[label](#d:id)` in a send_message of the
// main chat or a sub window ("its not showing me the issues"). Drives the real
// sessions view: a send_message with `details` whose text links one, rendered in
// the main chat's messages view and in the sub window opened in place; clicking
// the chip opens the detail popup in each.

const SEND = "mcp__cc_conductor__send_message";
const MAIN = sessionInstance({ session_id: "main", name: "Main chat", pid: 101, cwd: "C:/Projects/cv-site" });
const SUB = sessionInstance({
  session_id: "sub-one", name: "Sub one", pid: 102, cwd: "C:/Projects/cv-site", subchat_of: "main", busy: false, awaiting: null,
  subchat_finished: true, progress: { plan: null, state_since: new Date().toISOString() },
});

const events = (tag: string) => [
  { type: "user_message", content: [{ type: "text", text: `ask ${tag}` }], timestamp: 0 },
  { type: "tool_use", tool_name: SEND, id: `t-${tag}`, timestamp: 0, parent_tool_use_id: null, input: {
    kind: "answer", text: `Found [3 issues](#d:iss-${tag}) in ${tag}.`,
    details: [{ id: `iss-${tag}`, label: "3 issues", body_md: `- first issue of ${tag}\n- second\n- third` }],
  } },
  { type: "tool_result", tool_use_id: `t-${tag}`, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];

async function mount(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [MAIN, SUB],
      get_active_sessions: [MAIN, SUB],
      list_subchats_on: ["main"],
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: events("main"), oldest_seq: 0, newest_seq: 3, has_more: false },
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      list_slash_commands: [],
      list_auto_accept: [],
    },
  });
  await page.evaluate((hist) => {
    const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
    const orig = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: any) =>
      cmd === "load_history_page" && (hist as Record<string, unknown>)[args?.sessionId]
        ? Promise.resolve((hist as Record<string, unknown>)[args.sessionId])
        : orig(cmd, args);
  }, {
    main: { events: events("main"), oldest_seq: 0, newest_seq: 3, has_more: false },
    "sub-one": { events: events("sub"), oldest_seq: 0, newest_seq: 3, has_more: false },
  });
  await page.locator("#sessions-list li").first().waitFor();
}

test("a detail link in the main chat's message opens its popup", async ({ page }) => {
  await mount(page);
  await page.locator('#sessions-list li[data-session-id="main"]').click();
  const chip = page.locator("#session-pane .drill-chip");
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(page.locator("#session-pane .drill-pop")).toContainText("first issue of main");
});

test("a detail link in a sub window's message opens its popup", async ({ page }) => {
  await mount(page);
  await page.locator('#sessions-list li[data-session-id="main"]').click();
  await page.locator("#session-pane .session-header .sub-count-btn").click();
  await page.locator('.sub-list-popover .sub-row[data-sub-id="sub-one"]').click();
  await expect(page.locator("#session-pane .session-header .sub-back-btn")).toBeVisible();
  const chip = page.locator("#session-pane .drill-chip");
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(page.locator("#session-pane .drill-pop")).toContainText("first issue of sub");
});
