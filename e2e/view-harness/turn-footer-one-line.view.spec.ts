import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Everything a turn produced belongs on ONE wrapping chip line: tokens, time,
// every tool chip, and the peer-message chip. Screenshots hang below it, not
// between the meta chips and the strip.

const SHOTS = ".for_bepy/screenshots/_specs";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVR42mNk+M9QzzCKRsEoGgUAAiAB/6t8n4kAAAAASUVORK5CYII=";

function toolPair(tool: string, input: unknown, id: string, image = false): unknown[] {
  return [
    { type: "tool_use", tool_name: tool, input, id, timestamp: 0, parent_tool_use_id: null },
    {
      type: "tool_result",
      tool_use_id: id,
      output: image ? { type: "image", mime: "image/png", data: PNG_B64 } : { type: "text", text: "ok" },
      is_error: false,
      timestamp: 0,
    },
  ];
}

function historyPage(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "do the thing" }], timestamp: 0, remote_echo: false, author_session_id: null },
    ...toolPair("Bash", { command: "git log -1" }, "b1"),
    ...toolPair("Grep", { pattern: "foo" }, "g1"),
    ...toolPair("Read", { file_path: "C:/p/shot.png" }, "r1", true),
    // A peer's message mid-turn must not split the line into two footers.
    { type: "user_message", content: [{ type: "text", text: "heads up, touching pump.rs" }], timestamp: 0, remote_echo: false, author_session_id: "peer-1" },
    ...toolPair("Bash", { command: "cargo check" }, "b2"),
    {
      type: "turn_usage",
      input_tokens: 100,
      output_tokens: 4200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: 0,
      duration_ms: 92_000,
      has_thinking: false,
      model: "m",
    },
    { type: "user_message", content: [{ type: "text", text: "thanks" }], timestamp: 0, remote_echo: false, author_session_id: null },
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance({ session_id: "s1" }), sessionInstance({ session_id: "peer-1", cwd: "C:/Projects/alpha" })],
      get_active_sessions: [sessionInstance({ session_id: "s1" })],
      load_history_page: historyPage(),
    },
  });
  await page.locator('#sessions-list li[data-session-id="s1"]').click();
  await page.locator("#session-pane .session-messages .turn-footer .tool-strip").first().waitFor();
}

test("tokens, time, tools and the peer chip share one line, screenshots below", async ({ page }) => {
  await mountChat(page);

  // One chip-bearing footer for the whole run: the peer message must not have
  // rotated it. (The trailing "thanks" turn owns an empty, CSS-hidden footer.)
  const footers = page
    .locator("#session-pane .session-messages .turn-footer")
    .filter({ has: page.locator(".tool-chip") });
  await expect(footers).toHaveCount(1);
  const footer = footers.first();

  const tokens = footer.locator(".turn-chip--tokens");
  const time = footer.locator(".turn-chip--time");
  const bash = footer.locator('.tool-chip[data-tool="Bash"]');
  const peer = footer.locator('.tool-chip[data-tool="peer-msgs"]');
  for (const chip of [tokens, time, bash, peer]) await expect(chip).toBeVisible();
  await expect(bash.locator(".tool-chip-count")).toHaveText("x2");

  // Same line means same vertical band, not merely "both rendered".
  const boxes = await Promise.all([tokens, time, bash, peer].map(async (c) => (await c.boundingBox())!));
  const top = boxes[0]!.y;
  for (const box of boxes) expect(Math.abs(box.y - top)).toBeLessThan(box.height);

  // Screenshots hang under the line, and their chip stays on it.
  const block = footer.locator(".screenshot-block");
  await expect(block.locator(".screenshot-thumb")).toHaveCount(1);
  await expect(footer.locator('.tool-strip > .tool-chip[data-tool="Read"]')).toHaveCount(1);
  await expect(block.locator(".tool-chip")).toHaveCount(0);
  const blockBox = (await block.boundingBox())!;
  expect(blockBox.y).toBeGreaterThan(top);

  await footer.screenshot({ path: `${SHOTS}/turn-footer-one-line.png` });
});
