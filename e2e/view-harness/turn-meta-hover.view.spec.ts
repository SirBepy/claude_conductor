import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A settled turn's tokens + time are plain text at the right end of the chip
// line, invisible until the turn's bubble (or its footer) is hovered.

// Quiet mode hides raw assistant prose, so the bubble a user can hover is the
// send_message row.
function sendMessage(text: string, id: string): unknown[] {
  return [
    { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { text }, id, timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: id, output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
  ];
}

function historyPage(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "do the thing" }], timestamp: 0, remote_echo: false, author_session_id: null },
    { type: "tool_use", tool_name: "Bash", input: { command: "git log -1" }, id: "b1", timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: "b1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
    ...sendMessage("Done, the footer is tidy.", "m1"),
    {
      type: "turn_usage",
      input_tokens: 100,
      output_tokens: 3500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: 0,
      duration_ms: 18_000,
      has_thinking: false,
      model: "m",
    },
    { type: "user_message", content: [{ type: "text", text: "thanks" }], timestamp: 0, remote_echo: false, author_session_id: null },
    ...sendMessage("Anytime.", "m2"),
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance({ session_id: "s1" })],
      get_active_sessions: [sessionInstance({ session_id: "s1" })],
      load_history_page: historyPage(),
    },
  });
  await page.locator('#sessions-list li[data-session-id="s1"]').click();
  await page.locator("#session-pane .session-messages .turn-footer .tool-strip").first().waitFor();
}

const opacityOf = (page: Page, sel: string): Promise<number> =>
  page.locator(sel).first().evaluate((el) => Number(getComputedStyle(el).opacity));

test("tokens and time are hidden at rest, shown on bubble hover, right of the tool chips", async ({ page }) => {
  await mountChat(page);
  const footer = page
    .locator("#session-pane .session-messages .turn-footer")
    .filter({ has: page.locator(".tool-chip") })
    .first();
  const tokens = footer.locator(".turn-chip--tokens");
  const time = footer.locator(".turn-chip--time");
  await expect(tokens).toHaveText("3.5k tok");
  await expect(time).toHaveText("18s");

  // Plain text, not a pill.
  const border = await tokens.evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(border).toBe("0px");

  // Parked on the pointer-free corner first so a leftover hover cannot leak in.
  await page.mouse.move(0, 0);
  await expect.poll(() => opacityOf(page, ".turn-chip--tokens")).toBe(0);

  const bubble = page.locator("#session-pane .session-messages .msg.assistant", { hasText: "footer is tidy" });
  await bubble.hover();
  await expect.poll(() => opacityOf(page, ".turn-chip--tokens")).toBe(1);
  await expect.poll(() => opacityOf(page, ".turn-chip--time")).toBe(1);

  await page.locator("#session-pane .session-messages").screenshot({ path: ".for_bepy/screenshots/_specs/turn-meta-hover.png" });

  // Trailing: the numbers end up right of every tool chip on the same line.
  const bash = (await footer.locator('.tool-chip[data-tool="Bash"]').boundingBox())!;
  const tok = (await tokens.boundingBox())!;
  expect(tok.x).toBeGreaterThan(bash.x + bash.width);
  expect(Math.abs(tok.y - bash.y)).toBeLessThan(bash.height);

  // Hovering the NEXT turn's bubble must not light this turn's footer.
  await page.mouse.move(0, 0);
  await page.locator("#session-pane .session-messages .msg.assistant", { hasText: "Anytime" }).hover();
  await expect.poll(() => opacityOf(page, ".turn-chip--tokens")).toBe(0);
});
