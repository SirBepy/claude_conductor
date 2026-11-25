// Reviewed 2026-11-25 (model and effort are words, not battery glyphs; the desktop chat header is one line with one text chip): nothing this spec asserts changed, and it passes in the full view-suite run.
// Reviewed 2026-11-20 (V2 priority badge): the head's ring and per-head count became one top-right badge by priority and the daemon keeps a viewed mark; nothing this spec asserts changed. It passes.
// asserts: src/views/sessions/session-header.ts, src/views/sessions/session-header.css, src/views/sessions/chat-heads-model.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// Joe 2026-11-17: the chat heads draw a project's main chat as the project, with no character, so
// its header drops the character and the chat name ("main chat of <project>") and shows the
// project's face and name. Every other chat keeps today's header.

const MAIN = sessionInstance({ session_id: "main", name: "Main of the project", pid: 201, cwd: "C:/Projects/rodge", project_id: "p-rodge" });
const PLAIN = sessionInstance({ session_id: "plain", name: "Fix the footer", pid: 202, cwd: "C:/Projects/rodge", project_id: "p-rodge" });
const SUB = sessionInstance({ session_id: "sub-1", name: "Footer sub", pid: 203, cwd: "C:/Projects/rodge", project_id: "p-rodge", subchat_of: "main" });
const SESSIONS = [MAIN, PLAIN, SUB];

const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: SESSIONS, get_active_sessions: SESSIONS,
  list_session_characters: { main: "ada", plain: "ada" },
  character_asset_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=",
  list_subchats_on: ["main"],
  get_project_icon: null,
  get_project_tech: null,
  load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
};

async function open(page: Page, id: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await page.locator(`#sessions-list li[data-session-id="${id}"]`).click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
}

const header = (page: Page) => page.locator("#session-pane .session-header");

test.describe("view-harness / header of a project's main chat", () => {
  test("shows only the project: its face and name, no character, no chat-name line", async ({ page }) => {
    await open(page, "main");
    await expect(header(page)).toHaveClass(/is-project-main/);
    await expect(header(page).locator(".meta-proj")).toHaveText("rodge");
    await expect(header(page).locator(".session-header-project-face .proj-face")).toBeVisible();
    await expect(header(page).locator("img.char-avatar")).toHaveCount(0);
    await expect(header(page).locator(".header-char-clickable")).toHaveCount(0);
    // The chat's name is gone from the screen (the node stays for the title updates).
    await expect(header(page).locator(".title")).toBeHidden();
    const text = await header(page).innerText();
    expect(text).not.toContain("Main of the project");
    // The project face hydrates like the stack head's: with no icon it is the same monogram.
    await expect(header(page).locator(".proj-face")).toHaveClass(/is-monogram/);
    await capture(page, "session-header-main-chat");
  });

  test("the name still opens the project's dashboard and the model chips stay", async ({ page }) => {
    await open(page, "main");
    await expect(header(page).locator(".meta-proj")).toHaveClass(/is-link/);
    await expect(header(page).locator(".meta-cfg")).toBeVisible();
  });

  test("a plain chat keeps its character avatar and chat name", async ({ page }) => {
    await open(page, "plain");
    await expect(header(page)).not.toHaveClass(/is-project-main/);
    await expect(header(page).locator("img.session-header-char")).toBeVisible();
    await expect(header(page).locator(".title")).toHaveText("Fix the footer");
  });

  test("the header is as tall as a plain chat's, so switching chats moves nothing below it", async ({ page }) => {
    await open(page, "main");
    const main = (await header(page).boundingBox())!.height;
    await page.locator('#sessions-list li[data-session-id="plain"]').click();
    await expect(header(page)).not.toHaveClass(/is-project-main/);
    // The title is what gives a plain header its height, so wait until it is drawn.
    await expect(header(page).locator(".title")).toHaveText("Fix the footer");
    await waitForPaneSettled(page);
    // 1px of slack for font rounding; the shift this pins was 4px.
    await expect.poll(async () => Math.abs((await header(page).boundingBox())!.height - main)).toBeLessThanOrEqual(1);
  });
});
