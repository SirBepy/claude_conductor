import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Quiet mode hides every tool_use/tool_result element via .chat-narration, and
// folding one into a chip bucket does not strip that class - so a chip holding
// RAW rows (Bash/"Ran", Grep, Task) opened a 2px empty box. Real cascade only.

const SHOTS = ".for_bepy/screenshots/_specs";

function bashPair(id: string, cmd: string): unknown[] {
  return [
    { type: "tool_use", tool_name: "Bash", input: { command: cmd, description: cmd }, id, timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: id, output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
  ];
}

function bashTranscript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "check the guard" }], timestamp: 0, remote_echo: false },
  ];
  for (let i = 0; i < 9; i++) events.push(...bashPair(`b${i}`, `git log -${i + 1}`));
  events.push({ type: "assistant_message", content: [{ type: "text", text: "done" }], streaming: false, timestamp: 0 });
  events.push({ type: "user_message", content: [{ type: "text", text: "thanks" }], timestamp: 0, remote_echo: false });
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountBashChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: bashTranscript(),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator('#session-pane .session-messages .tool-chip[data-tool="Bash"]').waitFor();
}

function agentTranscript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "delegate it" }], timestamp: 0, remote_echo: false },
    { type: "tool_use", tool_name: "Task", input: { description: "sweep the logs" }, id: "t1", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_use", tool_name: "Bash", input: { command: "rg retry" }, id: "c1", timestamp: 0, parent_tool_use_id: "t1" },
    { type: "tool_result", tool_use_id: "c1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
    { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "done" }, is_error: false, timestamp: 0 },
    { type: "tool_use", tool_name: "Edit", input: { file_path: "C:/p/a.ts", old_string: "a", new_string: "b" }, id: "e1", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: "e1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
    { type: "user_message", content: [{ type: "text", text: "thanks" }], timestamp: 0, remote_echo: false },
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

test("a Subagent chip opens its nested strip, and File Changes its file rows", async ({ page }) => {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: agentTranscript(),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  const messages = page.locator("#session-pane .session-messages");

  // Raw rows: the subagent's own tool row must be readable once drilled into.
  const taskChip = messages.locator('.tool-chip[data-tool="Task"]');
  await taskChip.click();
  const subChip = messages.locator(".tool-chip--agent").first();
  await expect(subChip).toBeVisible();
  await subChip.click();
  await messages.locator('.tool-strip-group .tool-chip[data-tool="Bash"]').click();
  await expect(messages.locator(".tool-strip-group .tool-row").first()).toBeVisible();

  // Custom view: generated rows, never narration-hidden, and only ONE chip.
  const editChip = messages.locator('.tool-chip[data-tool="Edit"]');
  await expect(editChip).toHaveCount(1);
  await editChip.click();
  await expect(messages.locator(".tool-file-row").first()).toBeVisible();
});

test("a Ran chip opens its folded Bash rows in quiet mode", async ({ page }) => {
  await mountBashChat(page);

  const messages = page.locator("#session-pane .session-messages");
  await expect(messages).not.toHaveClass(/show-raw-chat/);

  const chip = messages.locator('.tool-chip[data-tool="Bash"]');
  await expect(chip.locator(".tool-chip-count")).toHaveText("x9");

  const rows = messages.locator('.tool-strip-group[data-tool="Bash"] .tool-row');
  await expect(rows).toHaveCount(18); // 9 calls + 9 results
  await expect(rows.first()).toBeHidden();

  await chip.click();
  await expect(chip).toHaveClass(/tool-chip--active/);
  await expect(rows.first()).toBeVisible();

  // The failure this guards is a panel that opens to nothing, so assert real
  // height, not just visibility.
  const panel = messages.locator(".tool-strip-panel").first();
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.height).toBeGreaterThan(100);
  const rowBox = (await rows.first().boundingBox())!;
  expect(rowBox.height).toBeGreaterThan(14);

  await panel.screenshot({ path: `${SHOTS}/chat-tool-chip-panel.png` });
});
