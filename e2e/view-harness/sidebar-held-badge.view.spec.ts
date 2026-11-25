// Reviewed 2026-11-25 (model and effort are words, not battery glyphs; the desktop chat header is one line with one text chip): nothing this spec asserts changed, and it passes in the full view-suite run.
// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-20 (V2 priority badge): the head's ring and per-head count became one top-right badge by priority and the daemon keeps a viewed mark; nothing this spec asserts changed. It passes.
// Reviewed 2026-11-16 (chat heads, pc-1769): the held corner badge is a hover-card fact.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/sidebar-hover-card.ts
import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance } from "./harness";

// Held-message cross-surface visibility (the "message waiting" ask): a chat head
// must carry its held_count without the session being the open chat. A head has
// no corner badge for it (the design keeps heads to ring, battery, badge and red
// count), so the count is a hover-card fact: `data-facts` holds "N held" and the
// card lists it.

function instance(over: Parameters<typeof sessionInstance>[0] = {}) {
  return sessionInstance({
    cwd: "C:/Projects/claude_usage_in_taskbar", started_at: "2026-07-30T10:00:00Z",
    name: "Held badge session", ...over,
  });
}

test.describe("view-harness / sidebar held-message badge", () => {
  test("shows the queued count on a backgrounded session, none on an idle one", async ({ page }) => {
    const sessions = [
      instance({ held_count: 2 }),
      instance({ session_id: "s2", cwd: "C:/Projects/zng-app", name: "No held messages" }),
    ];
    await mountSessionsList(page, sessions);

    await expect(page.locator('li[data-session-id="s1"]')).toHaveAttribute("data-facts", "2 held");
    await expect(page.locator('li[data-session-id="s2"]')).toHaveAttribute("data-facts", "");
  });

  test("a single queued message still carries the number", async ({ page }) => {
    await mountSessionsList(page, [instance({ held_count: 1 })]);
    await expect(page.locator('li[data-session-id="s1"]')).toHaveAttribute("data-facts", "1 held");
  });

  test("the held fact coexists with the attention mark without hiding either", async ({ page }) => {
    await mountSessionsList(page, [instance({ held_count: 3 })]);
    const row = page.locator('li[data-session-id="s1"]');
    // Simulate the parked-prompt attention state the same way
    // sidebar-row-style.view.spec.ts does - pendingPromptSessionIds is
    // module-internal state, not reachable through a mocked IPC call.
    await row.evaluate((li) => li.classList.add("needs-attention"));

    await expect(row).toHaveClass(/needs-attention/);
    await expect(row).toHaveAttribute("data-facts", "3 held");
  });

  test("the hover card lists the held messages", async ({ page }) => {
    await mountSessionsList(page, [instance({ held_count: 4 })]);
    const row = page.locator('li[data-session-id="s1"]');
    await expect(row).toHaveClass(/chat-head/);
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".cc-row-card")).toContainText("4 held");
  });
});
