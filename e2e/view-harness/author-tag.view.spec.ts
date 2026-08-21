import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Todo 682: a user bubble an AI sent on Joe's behalf carries an icon-pair
// tag (character + project), never a text label. Drives the real pipeline
// (sessions view + load_history_page), not a raw renderMessage() string
// assert, so the resolve-and-hydrate path is exercised end to end.

const SHOTS = ".for_bepy/screenshots/_specs";

// A tiny valid base64 SVG so hydrateCharacterAvatars/hydrateProjectTechIcons
// have real bytes to set as `src`, not just a non-empty string.
const FAKE_ICON_B64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==";

function historyPage(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    // Sent by Jarvis (session "jarvis-1"), whose identity fully resolves.
    { type: "user_message", content: [{ type: "text", text: "build the login page" }], timestamp: 0, remote_echo: false, is_meta: false, author_session_id: "jarvis-1" },
    { type: "assistant_message", content: [{ type: "text", text: "On it." }], streaming: false, timestamp: 0 },
    // Joe's own message: no author at all.
    { type: "user_message", content: [{ type: "text", text: "plain message from Joe" }], timestamp: 0, remote_echo: false, is_meta: false, author_session_id: null },
    { type: "assistant_message", content: [{ type: "text", text: "Sure." }], streaming: false, timestamp: 0 },
    // Sent by a session that no longer exists anywhere in memory.
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
      ],
      get_active_sessions: [sessionInstance({ session_id: "s1", cwd: "C:/Projects/alpha" })],
      list_session_characters: { "jarvis-1": "hogger" },
      character_asset_url: `data:image/svg+xml;base64,${FAKE_ICON_B64}`,
      get_project_icon: { mime: "image/svg+xml", base64: FAKE_ICON_B64 },
      load_history_page: historyPage(),
    },
  });
  await page.locator('#sessions-list li[data-session-id="s1"]').click();
  await page.locator("#session-pane .session-messages .msg.user").first().waitFor();
}

test("an AI-authored bubble renders the icon-pair tag and resolves both icons", async ({ page }) => {
  await mountChat(page);

  const authored = page.locator(".msg.user", { hasText: "build the login page" });
  const tag = authored.locator(".author-tag");
  await expect(tag).toHaveCount(1);
  await expect(authored).toHaveClass(/msg-user--authored/);

  const charIcon = tag.locator("img.char-avatar");
  await expect(charIcon).toHaveAttribute("data-character-id", "hogger");
  await expect(charIcon).toHaveAttribute("data-hydrated", "hogger", { timeout: 5000 });
  await expect(charIcon).toHaveAttribute("src", /^data:/);

  const projFace = tag.locator(".proj-face");
  await expect(projFace).toHaveAttribute("data-proj-face", "C:/Projects/jarvis-home");
  await expect(projFace).toHaveAttribute("data-hydrated", "C:/Projects/jarvis-home", { timeout: 5000 });
  await expect(projFace.locator("img")).toHaveCount(1);

  await authored.screenshot({ path: `${SHOTS}/author-tag.png` });
});

test("a message Joe typed himself renders no tag at all", async ({ page }) => {
  await mountChat(page);

  const plain = page.locator(".msg.user", { hasText: "plain message from Joe" });
  await expect(plain).toHaveCount(1);
  await expect(plain.locator(".author-tag")).toHaveCount(0);
  await expect(plain).not.toHaveClass(/msg-user--authored/);
});

test("an author id that resolves to nothing still renders a tag, never a broken bubble", async ({ page }) => {
  await mountChat(page);

  const ghost = page.locator(".msg.user", { hasText: "relayed from a ghost session" });
  await expect(ghost).toHaveCount(1);
  const tag = ghost.locator(".author-tag");
  await expect(tag).toHaveCount(1);

  // No identity resolved for either half: generic fallback icons, no
  // half-blank placeholder, no data-character-id/data-proj-face left dangling.
  await expect(tag.locator("img.char-avatar")).toHaveCount(0);
  await expect(tag.locator(".author-tag-char i.ph-robot")).toHaveCount(1);
  await expect(tag.locator(".proj-face")).toHaveCount(0);
  await expect(tag.locator(".author-tag-proj i.ph-folder")).toHaveCount(1);

  await expect(ghost).toBeVisible();
});
