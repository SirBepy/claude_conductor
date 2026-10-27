// asserts: src/shared/chat/chat-pagination.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The history window is cut by assistant-reply count, so a long turn splits:
// the newest page holds its tail (tool rows and the closing send_message
// summary), an older page holds the opening user message and the earlier
// progress bubbles. The older page is fetched by the top sentinel and has to
// land ABOVE the tail in the real DOM, not between the summary and its footer.

const SEND = "mcp__cc_conductor__send_message";

function text(t: string) {
  return [{ type: "text", text: t }];
}

const NEWEST_PAGE = {
  events: [
    { type: "tool_use", tool_name: "Bash", input: { command: "git commit" }, id: "t5", timestamp: 2_040_000 },
    { type: "tool_result", tool_use_id: "t5", output: { type: "text", text: "ok" }, is_error: false, timestamp: 2_041_000 },
    { type: "tool_use", tool_name: SEND, input: { text: "SUMMARY both changes are committed" }, id: "s3", timestamp: 2_050_000 },
  ],
  oldest_seq: 20,
  newest_seq: 30,
  has_more: true,
};

const OLDER_PAGE = {
  events: [
    { type: "user_message", content: text("OPENER lets use impeccable"), timestamp: 2_000_000, remote_echo: false, is_meta: false, author_session_id: null },
    { type: "tool_use", tool_name: SEND, input: { text: "PROGRESS ONE reading the mount" }, id: "s1", timestamp: 2_010_000 },
    { type: "tool_use", tool_name: "Read", input: { file_path: "a.ts" }, id: "t1", timestamp: 2_011_000 },
    { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 2_012_000 },
    { type: "tool_use", tool_name: SEND, input: { text: "PROGRESS TWO starting edits" }, id: "s2", timestamp: 2_020_000 },
  ],
  oldest_seq: 0,
  newest_seq: 19,
  has_more: false,
};

async function openSplitTurn(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: NEWEST_PAGE,
      list_slash_commands: [],
    },
  });
  // A cursor-bearing request is the older page; the harness map can only
  // return one fixed value per command, so route by the beforeSeq argument.
  await page.evaluate(
    ({ newest, older }) => {
      const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) => {
        if (cmd === "load_history_page") {
          return Promise.resolve(args && args.beforeSeq !== undefined ? older : newest);
        }
        return passthrough(cmd, args);
      };
    },
    { newest: NEWEST_PAGE, older: OLDER_PAGE },
  );
  await page.locator("#sessions-list li[data-session-id]").first().click();
}

test("an older page's opener and progress bubbles render above the already-loaded summary", async ({ page }) => {
  await openSplitTurn(page);

  // Visible bubbles only: tool rows fold into the footer's chips.
  const bubbles = page.locator(".session-messages > .msg.user, .session-messages > .msg.assistant");
  await expect(bubbles).toHaveCount(4);
  const texts = (await bubbles.allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  const at = (needle: string) => texts.findIndex((t) => t.includes(needle));
  expect(at("OPENER")).toBeGreaterThanOrEqual(0);
  expect(at("OPENER")).toBeLessThan(at("PROGRESS ONE"));
  expect(at("PROGRESS ONE")).toBeLessThan(at("PROGRESS TWO"));
  expect(at("PROGRESS TWO")).toBeLessThan(at("SUMMARY"));
});
