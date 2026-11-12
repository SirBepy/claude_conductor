// asserts: src/shared/chat/shown-badly.ts, src/shared/chat/shown-badly.css, src/shared/chat/chat-message-card.ts, src/shared/chat/chat-renderer.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// "Shown badly": a right-click on a send_message card (a long-press on the phone
// raises the same contextmenu) opens a one-item menu; picking it opens the note
// dialog, and Log it sends the card's input and the note to flag_shown_badly.
// Same flow at desktop width and at phone width.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";
const BLOCKER = { kind: "blocker", verdict: "Waiting on Gate 2", text: "Gate 2 holds the project's edit slot" };

async function mountChat(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  const history = [
    { type: "user_message", content: [{ type: "text", text: "ship the keyboard fix" }], timestamp: 0, remote_echo: false },
    { type: "tool_use", tool_name: SEND, input: BLOCKER, id: "toolu_blk", timestamp: 0, parent_tool_use_id: null },
  ];
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
      flag_shown_badly: { ok: true },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

for (const vp of [{ name: "desktop", width: 900 }, { name: "phone", width: 390 }]) {
  test(`a card flagged shown badly sends its input and the note (${vp.name})`, async ({ page }) => {
    await mountChat(page, vp.width);
    const card = page.locator("#session-pane .session-messages .mc-root[data-msg-id='toolu_blk']");
    await expect(card).toBeVisible();
    await card.locator(".mc-full .mc-verdict").click({ button: "right" });
    const item = page.locator(".session-more-menu .smore-item", { hasText: "Shown badly" });
    await expect(item).toBeVisible();
    await capture(page, `shown-badly-menu-${vp.name}`);
    await item.click();

    const note = page.locator(".sbad-dialog .sbad-note");
    await expect(note).toBeFocused();
    await note.fill("It waits on Gate 2, not on me");
    await capture(page, `shown-badly-dialog-${vp.name}`);
    await page.locator(".sbad-dialog .app-confirm-ok").click();
    await expect(page.locator(".sbad-dialog")).toHaveCount(0);

    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "flag_shown_badly")).toHaveLength(1);
    const call = (await invokeCalls(page)).find((c) => c.cmd === "flag_shown_badly")!;
    expect(call.args).toMatchObject({
      chatId: SESSION.session_id,
      messageId: "toolu_blk",
      message: BLOCKER,
      note: "It waits on Gate 2, not on me",
    });
  });
}
