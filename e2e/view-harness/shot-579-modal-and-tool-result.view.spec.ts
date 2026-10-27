import { expect, test, type Page } from "@playwright/test";
import { assistantMsg, capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// Live-verify the "Load full output" button on a page-truncated
// tool_result (commit ddc5da90). The other half of this spec, the new-chat
// modal's left column, went with the modal.

const DESKTOP = { width: 1400, height: 900 };

const FULL_TEXT = "FULL-OUTPUT-MARKER-4242 restored from load_event_detail";

// The truncated result rides the INITIAL page on purpose (todo 738): that is
// the path a user hits just by opening a chat, and the backend truncates the
// newest page too. Scrollback used to be the only path carrying the flags.
const NEWEST_PAGE = {
  events: [
    userMsg("dump the build log"),
    { type: "tool_use", tool_name: "Bash", input: { command: "cat build.log" }, id: "tu1", timestamp: 0, parent_tool_use_id: null },
    {
      type: "tool_result",
      tool_use_id: "tu1",
      output: { type: "text", text: "line 1 of the build log preview…" },
      is_error: false,
      timestamp: 0,
      output_truncated: true,
      full_seq: 4200,
    },
    assistantMsg("Here is the log."),
  ] as unknown[],
  oldest_seq: 900,
  newest_seq: 1000,
  has_more: false,
};

async function openTruncatedResultRow(page: Page) {
  // Tool rows are quiet-mode narration; the chat menu's "show raw activity"
  // toggle is what reveals them, and it persists through this localStorage key.
  await page.addInitScript(() => localStorage.setItem("cc-show-raw-chat:s1", "1"));
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: NEWEST_PAGE,
      load_event_detail: {
        type: "tool_result",
        tool_use_id: "tu1",
        output: { type: "text", text: FULL_TEXT },
        is_error: false,
        timestamp: 0,
        output_truncated: false,
        full_seq: null,
      },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  // The Bash chip's panel is what holds the folded result row.
  const chip = page.locator("#session-pane .session-messages .tool-strip > .tool-chip[data-tool='Bash']");
  await chip.click();
  const row = page.locator("#session-pane .session-messages details.msg.tool-result");
  await expect(row).toHaveCount(1);
  await row.locator("summary").click();
  return row;
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("truncated tool result: Load full output swaps in real content", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const row = await openTruncatedResultRow(page);

    const btn = row.locator(".tool-result-load-full");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText(/Load full output/);
    await capture(row, "579-tool-result-truncated");

    await btn.click();
    await expect(btn).toHaveCount(0);
    await expect(row.locator(".tool-result-load-spin")).toHaveCount(0);
    await expect(row).toContainText(FULL_TEXT);
    await expect(row).not.toContainText("Failed to load");
    await capture(row, "579-tool-result-loaded");
  });
});
