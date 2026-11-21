// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-21 (the open chat's viewed mark is renewed every minute by a heartbeat in chat-seen.ts, started from sidebar.ts): nothing this spec asserts changed, and it passes in the run of every spec that depends on sidebar.ts.
// Reviewed 2026-11-21 (the closed toggle's number no longer counts hidden chats; the last two cases pin it). Earlier note: (the open chat's viewed mark is renewed every minute by a heartbeat in chat-seen.ts, started from sidebar.ts): nothing this spec asserts changed, and it passes in the run of every spec that depends on sidebar.ts.
// Reviewed 2026-11-20 (V2 priority badge): the head's ring and per-head count became one top-right badge by priority and the daemon keeps a viewed mark; nothing this spec asserts changed. It passes.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/sidebar.ts, src/views/sessions/sessions-dom-wiring.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountSessionsList, sessionInstance } from "./harness";

// Replaces sidebar-hidden-bottom.view.spec.ts (the Hidden group pinned to the sidebar's
// bottom edge). On the chat heads, hidden chats leave the stack; an eye-slash head with a
// count swaps the stack for them and a back head returns. The stack never scrolls: past the
// window's height it wraps into a second column (docs/chat-heads-design.md).

const HIDDEN_ID = "hidden-1";

function sessions(visible: number, over: Parameters<typeof sessionInstance>[0] = {}) {
  const rows = Array.from({ length: visible }, (_, i) =>
    sessionInstance({ session_id: `s${i + 1}`, pid: 100 + i, name: `Chat ${i + 1}`, cwd: `C:/Projects/p${i + 1}` }),
  );
  rows.push(sessionInstance({ session_id: HIDDEN_ID, pid: 999, name: "Hidden chat", cwd: "C:/Projects/old", ...over }));
  return rows;
}

async function seedHidden(page: Page, ids: string[] = [HIDDEN_ID]): Promise<void> {
  await page.addInitScript((list) => localStorage.setItem("cc_hidden_sessions", JSON.stringify(list)), ids);
}

const head = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const hiddenHead = (page: Page) => page.locator("#sessions-list li[data-heads-hidden]");
const backHead = (page: Page) => page.locator("#sessions-list li[data-heads-back]");
// The open chat's header: the hidden view draws no head for s1, so "opened" shows only here.
const paneTitle = (page: Page) => page.locator("#session-pane .session-header .title");
const toggleHead = (page: Page) => page.locator("#sessions-list li[data-heads-toggle]");

for (const [label, size] of [["desktop", { width: 1100, height: 900 }], ["phone", { width: 390, height: 800 }]] as const) {
  test.describe(`view-harness / chat heads hidden chats (${label})`, () => {
    test("a hidden chat leaves the stack and the eye-slash head carries the count", async ({ page }) => {
      await page.setViewportSize(size);
      await seedHidden(page);
      await mountSessionsList(page, sessions(2));
      await expect(head(page, "s1")).toBeVisible();
      await expect(head(page, HIDDEN_ID)).toHaveCount(0);
      await expect(hiddenHead(page)).toBeVisible();
      await expect(hiddenHead(page).locator(".chat-head-count")).toHaveText("1");
      await capture(page, `chat-heads-hidden-head-${label}`);
    });

    test("the eye-slash head swaps the stack for the hidden chats and the back head returns", async ({ page }) => {
      await page.setViewportSize(size);
      await seedHidden(page);
      await mountSessionsList(page, sessions(2));
      await hiddenHead(page).click();
      await expect(head(page, HIDDEN_ID)).toBeVisible();
      await expect(head(page, "s1")).toHaveCount(0);
      await expect(backHead(page)).toBeVisible();
      await expect(hiddenHead(page)).toHaveCount(0);
      // Hidden chats are not "heads 1-9": no number for Ctrl+N.
      await expect(head(page, HIDDEN_ID)).not.toHaveAttribute("data-kbd-hint", /.+/);
      await capture(page, `chat-heads-hidden-open-${label}`);

      await backHead(page).click();
      await expect(head(page, "s1")).toBeVisible();
      await expect(head(page, HIDDEN_ID)).toHaveCount(0);
    });

    test("Ctrl+1 in the hidden-chats view opens nothing: the numbers belong to the stack that is off screen", async ({ page }) => {
      await page.setViewportSize(size);
      await seedHidden(page);
      await mountSessionsList(page, sessions(2), {
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        list_slash_commands: [],
      });
      await hiddenHead(page).click();
      await expect(head(page, HIDDEN_ID)).toBeVisible();
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.keyboard.press("Control+1");
      await page.waitForTimeout(300);
      await expect(paneTitle(page)).toHaveCount(0);
      // Back on the stack the same key opens head 1.
      await backHead(page).click();
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.keyboard.press("Control+1");
      await expect(paneTitle(page)).toHaveText("Chat 1");
    });

    test("Ctrl+1 with the stack closed after the hidden view was left open still opens head 1", async ({ page }) => {
      await page.setViewportSize(size);
      await seedHidden(page);
      await mountSessionsList(page, sessions(2), {
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        list_slash_commands: [],
      });
      await hiddenHead(page).click();
      // The toggle closes the stack but leaves the hidden view flagged; no hidden view is on screen.
      await toggleHead(page).click();
      await expect(head(page, HIDDEN_ID)).toHaveCount(0);
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.keyboard.press("Control+1");
      await expect(paneTitle(page)).toHaveText("Chat 1");
    });

    test("with nothing hidden there is no eye-slash head", async ({ page }) => {
      await page.setViewportSize(size);
      await mountSessionsList(page, sessions(2).slice(0, 2));
      await expect(head(page, "s1")).toBeVisible();
      await expect(hiddenHead(page)).toHaveCount(0);
    });

    test("messaging a hidden chat brings it back into the stack", async ({ page }) => {
      await page.setViewportSize(size);
      await seedHidden(page);
      await mountSessionsList(page, sessions(2), {
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        list_slash_commands: [],
        send_message: null,
      });
      await hiddenHead(page).click();
      await head(page, HIDDEN_ID).click();
      await page.locator(".session-composer .composer-textarea").fill("back again");
      await page.locator(".session-composer .composer-send").click();
      await expect.poll(() => page.evaluate(() => localStorage.getItem("cc_hidden_sessions"))).not.toContain(HIDDEN_ID);
      await expect(hiddenHead(page)).toHaveCount(0);
    });

    test("a hidden chat that asks adds nothing to the closed toggle's red number", async ({ page }) => {
      await page.setViewportSize(size);
      await seedHidden(page);
      await mountSessionsList(page, sessions(2, { awaiting: "question" }));
      // Only the hidden chat asks, and a hidden chat draws no number.
      await expect(head(page, "s1")).toBeVisible();
      await expect(page.locator("#sessions-list li[data-session-id] .ht-n.is-red")).toHaveCount(0);
      await toggleHead(page).click();
      await expect(head(page, "s1")).toHaveCount(0);
      // Closed stack: nothing drawn on the stack asks, so the toggle shows no number either.
      await expect(toggleHead(page).locator(".chat-head-count")).toHaveCount(0);
      await expect(toggleHead(page)).not.toHaveClass(/has-waiting/);
      await capture(page, `chat-heads-hidden-asks-${label}`);
    });

    test("the closed toggle's red number equals the red numbers the open stack draws", async ({ page }) => {
      await page.setViewportSize(size);
      await seedHidden(page);
      const rows = sessions(2, { awaiting: "question" });
      // s1 asks as well: one red head in the stack, one asking chat behind the eye.
      rows[0] = sessionInstance({ session_id: "s1", pid: 100, name: "Chat 1", cwd: "C:/Projects/p1", awaiting: "question" });
      await mountSessionsList(page, rows);
      const reds = await page.locator("#sessions-list li[data-session-id] .ht-n.is-red").allTextContents();
      expect(reds).toEqual(["1"]);
      await toggleHead(page).click();
      await expect(toggleHead(page).locator(".chat-head-count")).toHaveText("1");
    });
  });
}

test.describe("view-harness / chat heads wrap instead of scrolling", () => {
  test("a stack taller than the window wraps into a second column and every head keeps its size", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 360 });
    await mountSessionsList(page, sessions(10).slice(0, 10));
    await expect(head(page, "s10")).toBeAttached();

    const m = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>("#sessions-list")!;
      // The ghost + and Hidden buttons are 26px on purpose (own spec in chat-heads-motion).
      const heads = [...list.querySelectorAll<HTMLElement>("li.chat-head:not(.chat-head-ghost)")];
      return {
        overflow: list.scrollHeight - list.clientHeight,
        sizes: heads.map((h) => [Math.round(h.getBoundingClientRect().width), Math.round(h.getBoundingClientRect().height)]),
        columns: new Set(heads.map((h) => Math.round(h.getBoundingClientRect().left))).size,
      };
    });
    expect(m.overflow).toBeLessThanOrEqual(0);
    for (const s of m.sizes) expect(s).toEqual([44, 44]);
    expect(m.columns).toBeGreaterThanOrEqual(2);
    await capture(page, "chat-heads-wrapped-columns");
  });

  test("a tall window keeps the whole stack in one column", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await mountSessionsList(page, sessions(3).slice(0, 3));
    await expect(head(page, "s3")).toBeAttached();
    const columns = await page.evaluate(
      () => new Set([...document.querySelectorAll<HTMLElement>("#sessions-list li.chat-head:not(.chat-head-ghost)")].map((h) => Math.round(h.getBoundingClientRect().left))).size,
    );
    expect(columns).toBe(1);
  });
});
