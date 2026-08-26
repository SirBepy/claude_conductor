import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Todo 682/follow-up: session-relayed ("authored") messages fold into one
// .tool-chip on their turn's shared chip line, never their own bubbles. A peer
// message does not rotate the turn, so it is one chip per run between two of
// Joe's own messages. Real pipeline, not a renderMessage() string assert.

const SHOTS = ".for_bepy/screenshots/_specs";
const PEER_CHIP = '#session-pane .session-messages .turn-footer .tool-chip[data-tool="peer-msgs"]';
const FAKE_ICON_B64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==";

function historyPage(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    // Two DIFFERENT peer sessions back to back, no Joe reply between them -
    // both fold into ONE chip.
    { type: "user_message", content: [{ type: "text", text: "build the login page" }], timestamp: 0, remote_echo: false, is_meta: false, author_session_id: "jarvis-1" },
    { type: "user_message", content: [{ type: "text", text: "found the root cause" }], timestamp: 0, remote_echo: false, is_meta: false, author_session_id: "scout-1" },
    // Joe's own message breaks the run - a later authored message must NOT
    // fold into the earlier group.
    { type: "user_message", content: [{ type: "text", text: "plain message from Joe" }], timestamp: 0, remote_echo: false, is_meta: false, author_session_id: null },
    { type: "user_message", content: [{ type: "text", text: "one more thing" }], timestamp: 0, remote_echo: false, is_meta: false, author_session_id: "jarvis-1" },
    // Another Joe message, then a session that no longer exists anywhere in
    // memory - its own separate group, singular.
    { type: "user_message", content: [{ type: "text", text: "thanks" }], timestamp: 0, remote_echo: false, is_meta: false, author_session_id: null },
    { type: "user_message", content: [{ type: "text", text: "relayed from a ghost session" }], timestamp: 0, remote_echo: false, is_meta: false, author_session_id: "ghost-999" },
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [
        sessionInstance({ session_id: "s1", cwd: "C:/Projects/alpha" }),
        sessionInstance({ session_id: "jarvis-1", cwd: "C:/Projects/jarvis-home", jarvis: true }),
        sessionInstance({ session_id: "scout-1", cwd: "C:/Projects/scout-worker" }),
      ],
      get_active_sessions: [sessionInstance({ session_id: "s1", cwd: "C:/Projects/alpha" })],
      list_session_characters: { "jarvis-1": "hogger", "scout-1": "arthas" },
      character_asset_url: `data:image/svg+xml;base64,${FAKE_ICON_B64}`,
      get_project_icon: { mime: "image/svg+xml", base64: FAKE_ICON_B64 },
      load_history_page: historyPage(),
    },
  });
  await page.locator('#sessions-list li[data-session-id="s1"]').click();
  await page.locator(PEER_CHIP).first().waitFor();
}

test("two different peer sessions back to back fold into one chip", async ({ page }) => {
  await mountChat(page);

  const chips = page.locator(PEER_CHIP);
  await expect(chips).toHaveCount(3); // [jarvis+scout ×2], [jarvis ×1], [ghost ×1] - each run separated by a Joe message

  const firstChip = chips.first();
  await expect(firstChip.locator(".tool-chip-label")).toHaveText("jarvis-home & scout-worker");
  await expect(firstChip.locator(".tool-chip-count")).toHaveText("×2");
  await expect(firstChip.locator(".author-avatar")).toHaveCount(2);

  // Panel starts closed.
  const footer = page.locator("#session-pane .session-messages .turn-footer").first();
  const panel = footer.locator(".tool-strip-panel");
  await expect(panel).toBeHidden();
  await firstChip.click();
  await expect(panel).toBeVisible();

  const rows = panel.locator(".author-group-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator(".author-group-row-name")).toHaveText("jarvis-home");
  await expect(rows.nth(0).locator(".author-group-row-text")).toHaveText("build the login page");
  await expect(rows.nth(1).locator(".author-group-row-name")).toHaveText("scout-worker");
  await expect(rows.nth(1).locator(".author-group-row-text")).toHaveText("found the root cause");

  await footer.screenshot({ path: `${SHOTS}/author-message-group.png` });
});

test("a message Joe typed himself breaks the run and renders no chip", async ({ page }) => {
  await mountChat(page);

  const plain = page.locator(".msg.user", { hasText: "plain message from Joe" });
  await expect(plain).toHaveCount(1);
  await expect(plain.locator(".tool-chip")).toHaveCount(0);

  // The lone post-interruption Jarvis message gets its OWN chip, not folded
  // into the first group.
  const secondChip = page.locator(PEER_CHIP).nth(1);
  await expect(secondChip.locator(".tool-chip-label")).toHaveText("jarvis-home");
  await expect(secondChip.locator(".tool-chip-count")).toHaveCount(0); // singular - no ×N suffix
});

test("an author id that resolves to nothing still renders a chip, never a broken row", async ({ page }) => {
  await mountChat(page);

  const ghostChip = page.locator(PEER_CHIP).last();
  await expect(ghostChip.locator(".tool-chip-label")).toHaveText("peer session");
  await expect(ghostChip.locator(".author-avatar i.ph-robot")).toHaveCount(1);
  await expect(ghostChip.locator("img.char-avatar")).toHaveCount(0);
  await expect(ghostChip).toBeVisible();
});
