import { expect, test, type Page } from "@playwright/test";
import { assistantMsg, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// asserts: src/shared/chat/elided-image-loader.ts, src/shared/chat/elided-image.ts, src/shared/chat/screenshot-row.ts

// A history page leaves an oversized screenshot's base64 out (history_page.rs
// IMAGE_INLINE_MAX_B64) and tags the tool_result with full_seq. The chat shows
// a placeholder box and fetches the real image through load_event_detail once
// the box scrolls near view.

const DESKTOP = { width: 1400, height: 900 };

// A real 1x1 PNG, so the swapped-in <img> actually decodes.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const SHOT_SEQ = 4200;

const elidedShot = [
  { type: "tool_use", tool_name: "Bash", input: { command: "capture.ps1", description: "capture window" }, id: "tu1", timestamp: 0, parent_tool_use_id: null },
  {
    type: "tool_result",
    tool_use_id: "tu1",
    output: { type: "image", mime: "image/png", data: "" },
    is_error: false,
    timestamp: 0,
    output_truncated: true,
    full_seq: SHOT_SEQ,
    output_bytes: 1572864,
  },
];

const DETAIL = {
  type: "tool_result",
  tool_use_id: "tu1",
  output: { type: "image", mime: "image/png", data: PNG_1X1 },
  is_error: false,
  timestamp: 0,
  output_truncated: false,
  full_seq: null,
  output_bytes: null,
};

/** The screenshot turn first, then `filler` tall replies: the chat opens
 *  scrolled to the bottom, so the screenshot starts far out of view. */
function transcript(filler: number) {
  const events: unknown[] = [userMsg("capture the window"), ...elidedShot, assistantMsg("Captured.")];
  for (let i = 0; i < filler; i++) {
    events.push(userMsg(`question ${i}`));
    events.push(assistantMsg(`answer ${i}\n\n` + "filler line\n\n".repeat(30)));
  }
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountChat(page: Page, filler: number): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: transcript(filler),
      load_event_detail: DETAIL,
    },
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
}

const detailCalls = async (page: Page) => (await invokeCalls(page)).filter((c) => c.cmd === "load_event_detail");

test("an elided screenshot in view loads by itself and becomes a real image", async ({ page }) => {
  await mountChat(page, 0);
  const thumb = page.locator("#session-pane .screenshot-thumb");
  await expect(thumb.locator("img")).toHaveCount(1);
  expect(await thumb.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await expect(thumb).not.toHaveAttribute("data-elided-image", /.*/);

  const calls = await detailCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toMatchObject({ sessionId: "s1", seq: SHOT_SEQ, toolUseId: "tu1" });
});

test("an elided screenshot far off screen stays a placeholder until it scrolls near view", async ({ page }) => {
  await mountChat(page, 30);
  const placeholder = page.locator("#session-pane .screenshot-thumb[data-elided-image]");
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder).toContainText("image/png, 1.5 MB");
  // The chat paints from the top, then pins to the bottom: wait out the
  // loader's settle delay so a premature load would have shown up by now.
  await page.waitForTimeout(800);
  expect(await placeholder.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(-400); // past the loader's 300px lookahead
  expect(await placeholder.getAttribute("data-elided-state")).toBeNull();
  expect(await detailCalls(page)).toHaveLength(0);

  await placeholder.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(page.locator("#session-pane .screenshot-thumb img")).toHaveCount(1);
  await expect(page.locator("#session-pane .screenshot-thumb[data-elided-image]")).toHaveCount(0);
  expect(await detailCalls(page)).toHaveLength(1);
});
