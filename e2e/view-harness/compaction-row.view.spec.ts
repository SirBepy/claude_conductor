import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled, capture } from "./harness";

// asserts: src/shared/chat/chat-transforms.ts, src/shared/chat/chat-event-handler-messages.ts, src/shared/chat/chat-classifiers.ts
//
// A compaction draws one quiet row in the Messages view, desktop and phone
// width, and none of its lines (the /compact command, the local-command
// caveat and stdout) shows as a message from Joe. The events are what the Rust
// parser makes of the spike's real transcript lines (tests/fixtures/compact-spike).

const HISTORY = JSON.parse(readFileSync(resolve("tests/fixtures/compact-spike/history-events.json"), "utf8")) as unknown[];
const SESSION = sessionInstance();
const SEND = "mcp__cc_conductor__send_message";

const JOE = "Also an open job for you to remember: ping me about the 'quokka-migration' before touching delta.js again, no exceptions, and keep the word 'plinth' out of every commit message.";

function said(id: string, text: string, ts: number): unknown[] {
  return [
    { type: "tool_use", tool_name: SEND, input: { kind: "answer", verdict: "Noted", text }, id, timestamp: ts, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: ts },
  ];
}

const EVENTS = [
  { type: "user_message", content: [{ type: "text", text: JOE }], timestamp: 1794487000000, remote_echo: false, is_meta: false, author_session_id: null },
  ...said("m1", "Noted: quokka-migration before delta.js, and no 'plinth' in commits.", 1794487001000),
  ...HISTORY,
  { type: "user_message", content: [{ type: "text", text: "What was the checkout flag called?" }], timestamp: 1794487300000, remote_echo: false, is_meta: false, author_session_id: null },
  ...said("m2", "zebra-lantern-92, unrenamed.", 1794487301000),
];

async function openChat(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: EVENTS, oldest_seq: 0, newest_seq: 20, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .compact-chip").waitFor();
  await waitForPaneSettled(page);
}

for (const [name, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 800 }]] as const) {
  test(`one quiet compaction row, no Joe bubble (${name})`, async ({ page }) => {
    await openChat(page, size);
    const pane = page.locator("#session-pane .session-messages");

    const chip = pane.locator(".compact-chip");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText("Compacted 85.8k to 9.9k");
    await expect(chip).toHaveAttribute("title", "Context compacted in 21s");

    const userText = await pane.locator(".msg.user").allInnerTexts();
    expect(userText.join("\n")).not.toMatch(/\/compact|local-command|PreCompact|This session is being continued/);
    await expect(pane.getByText("Scheduled wake")).toHaveCount(0);

    await capture(pane, `compaction-row-${name}`);
  });
}
