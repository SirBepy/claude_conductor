import { test, expect, type Page } from "@playwright/test";
import { mountView, invokeCalls, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The show_preview card through the REAL live pipeline. Unit tests cover the
// event mapping and the markup string; only a browser proves the row survives
// buildMessageEl, that render_preview_doc is really invoked, and that the
// 640px geometry holds against the real stylesheet.

const PREVIEW_URL = "http://127.0.0.1:1/hooks/preview-render/spec";

function transcript(html = "<p id=\"pushed\">hello</p>"): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  return {
    events: [
      { type: "user_message", content: [{ type: "text", text: "show me the week" }], timestamp: 0, remote_echo: false, is_meta: false },
      {
        type: "tool_use",
        tool_name: "mcp__cc_conductor__show_preview",
        input: { slug: "clockify-week", html },
        id: "tu-preview",
        timestamp: 0,
        parent_tool_use_id: null,
      },
      { type: "tool_result", tool_use_id: "tu-preview", output: { type: "text", text: "preview shown in chat" }, is_error: false, timestamp: 0 },
    ],
    oldest_seq: 0,
    newest_seq: 0,
    has_more: false,
  };
}

async function mountChat(page: Page, html?: string): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: transcript(html),
      render_preview_doc: PREVIEW_URL,
      list_previews: [],
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .msg.preview-card").waitFor();
}

test("a show_preview push renders as an expanded card, not hidden narration", async ({ page }) => {
  await mountChat(page);

  const card = page.locator("#session-pane .msg.preview-card");
  await expect(card).toHaveCount(1);
  // Landing collapsed would defeat the whole point: zero clicks to see it.
  await expect(card).toHaveClass(/\bopen\b/);
  await expect(card.locator(".pc-label")).toHaveText("Clockify Week");
  await expect(card).toBeVisible();

  // Narration is display:none by default; the card must not inherit that.
  await expect(card).not.toHaveClass(/chat-narration/);

  // Shared, gitignored, session-agnostic - never a live session's folder.
  await card.screenshot({ path: ".for_bepy/screenshots/_specs/preview-card.png" });
});

test("the pushed document reaches the iframe via render_preview_doc", async ({ page }) => {
  await mountChat(page);

  const iframe = page.locator("#session-pane .msg.preview-card .pc-frame");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("src", PREVIEW_URL);

  // The staged document must be the pushed html, and it must have gone through
  // buildPreviewDocumentHtml rather than being handed over raw.
  const staged = (await invokeCalls(page))
    .filter((c) => c.cmd === "render_preview_doc")
    .map((c) => (c.args as { html?: string } | undefined)?.html ?? "");
  expect(staged).toHaveLength(1);
  expect(staged[0]).toContain("id=\"pushed\"");
  expect(staged[0]).toContain("Content-Security-Policy");
});

test("a card that iframes a gallery render-url stages that iframe untouched", async ({ page }) => {
  // The /preview "show it inline first" shape. The nested id must reach the
  // staged document verbatim: the daemon's render cache has to keep it loadable.
  const galleryUrl = "http://127.0.0.1:27182/hooks/preview-render/gallery-id";
  await mountChat(page, `<iframe src="${galleryUrl}" style="width:100%;height:400px"></iframe>`);

  await expect(page.locator("#session-pane .msg.preview-card .pc-frame")).toHaveAttribute("src", PREVIEW_URL);
  const staged = (await invokeCalls(page))
    .filter((c) => c.cmd === "render_preview_doc")
    .map((c) => (c.args as { html?: string } | undefined)?.html ?? "");
  expect(staged).toHaveLength(1);
  expect(staged[0]).toContain(`src="${galleryUrl}"`);
});

test("the card carries the question card's geometry at its own 640px cap", async ({ page }) => {
  await mountChat(page);

  const card = page.locator("#session-pane .msg.preview-card");
  // Centered, per the shape Joe picked - measured, not asserted from the class.
  const box = (await card.boundingBox())!;
  const paneBox = (await page.locator("#session-pane .session-messages").boundingBox())!;
  const cardCentre = box.x + box.width / 2;
  const paneCentre = paneBox.x + paneBox.width / 2;
  expect(Math.abs(cardCentre - paneCentre)).toBeLessThan(2);
  expect(box.width).toBeLessThanOrEqual(640);

  await expect(card).toHaveCSS("border-radius", "10px");
});

test("clicking the header folds the card, and the pop button does not", async ({ page }) => {
  await mountChat(page);

  const card = page.locator("#session-pane .msg.preview-card");
  const body = card.locator(".pc-body");
  await expect(body).toBeVisible();

  await card.locator(".pc-summary").click();
  await expect(card).not.toHaveClass(/\bopen\b/);
  await expect(body).toBeHidden();

  await card.locator(".pc-summary").click();
  await expect(card).toHaveClass(/\bopen\b/);

  // The pop button lives inside the header; if its click were not stopped it
  // would collapse the card on its way to the rail.
  await card.locator(".pc-pop").click();
  await expect(card).toHaveClass(/\bopen\b/);
});

// Two pushes of one slug, then a second slug refused: through the real browser
// the chat must show the second push's card alone, plus a reason stub (and no
// white frame) for the refused one, as it does after a reload from scrollback.
test("a re-pushed slug leaves one card and a refused push leaves a reason, not a blank frame", async ({ page }) => {
  const use = (id: string, slug: string, title: string, html: string) => ({
    type: "tool_use",
    tool_name: "mcp__cc_conductor__show_preview",
    input: { slug, title, html },
    id,
    timestamp: 0,
    parent_tool_use_id: null,
  });
  const result = (id: string, isError: boolean, text: string) => ({
    type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: isError, timestamp: 0,
  });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: {
        events: [
          { type: "user_message", content: [{ type: "text", text: "show me" }], timestamp: 0, remote_echo: false, is_meta: false },
          use("tu-a1", "week", "Week v1", "<p id=\"v1\">one</p>"),
          result("tu-a1", false, "preview shown in chat"),
          use("tu-a2", "week", "Week v2", "<p id=\"v2\">two</p>"),
          result("tu-a2", false, "preview shown in chat"),
          use("tu-b", "month", "Month", "<p>month</p>"),
          result("tu-b", true, "relay error: HTTP 410 the card's iframe points at a render id the daemon no longer holds"),
        ],
        oldest_seq: 0,
        newest_seq: 0,
        has_more: false,
      },
      render_preview_doc: PREVIEW_URL,
      list_previews: [],
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .msg.preview-card").first().waitFor();

  const cards = page.locator("#session-pane .msg.preview-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator(".pc-label")).toHaveText("Week v2");
  await expect(cards.nth(1).locator(".pc-label")).toHaveText("Month");
  await expect(cards.nth(1).locator(".pc-frame")).toHaveCount(0);
  await expect(cards.nth(1).locator(".pc-failed")).toContainText("Preview was not accepted");
  const staged = (await invokeCalls(page))
    .filter((c) => c.cmd === "render_preview_doc")
    .map((c) => (c.args as { html?: string } | undefined)?.html ?? "");
  expect(staged.some((h) => h.includes("id=\"v2\""))).toBe(true);
  await cards.nth(1).screenshot({ path: ".for_bepy/screenshots/_specs/preview-card-refused.png" });
});
