// Reviewed 2026-10-25 (desktop split): sessions-dom-wiring.ts only had wirePreviewPanel's doc comment reworded for the desktop split; nothing this spec drives changed.
// Reviewed 2026-10-25 (project dashboard moved into new-chat drafts and a page opened from the chat header's project name; the Projects tab, Projects page and project page are gone): this spec drives none of those surfaces and passed after the change, so its contract is unaffected.
// Reviewed 2026-10-22: sessions.css's .composer-shell field overrides now skip #prompt-card-host (the phone question page's Preview reply bar) - no change for the main composer this spec drives, and it passes.
// Reviewed 2026-10-22: sessions-dom-wiring.ts passes the FAB a Code-mode opener; this spec asserts keyboard hints only, so its contract is unaffected.
// Reviewed 2026-10-20: shortcuts.ts gained a new "toggle-wrap-up-on-done" entry (ctrl+shift+w), registered in sessions-dom-wiring.ts alongside close-chat - both additive, no change to this spec's Ctrl-held chat-number hint/stagger behavior.
import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance, fireEvent } from "./harness";

// Joe, 2026-10-19: Ctrl+N correctly jumps chats, but the sidebar's held-Ctrl
// chat-number badges used to replay their stagger-in entrance every time a
// jump reshuffled which row got which number (selecting a session can move
// it between sidebar segments, re-sorting the list - sessions-helpers.ts's
// sortSessions runs on every render). sessions-dom-wiring.ts now plays the
// entrance only once per Ctrl keydown (the transient kbd-hint-entering
// class, auto-cleared after KBD_HINT_ENTER_MS) while the always-on
// kbd-hint-active class just displays the badges with no animation property
// at all - so a reshuffled badge updates its number in place instead of
// re-animating, for as long as Ctrl stays held.
//
// asserts: src/views/sessions/sessions-dom-wiring.ts, src/views/sessions/sessions.css
// (close-chat row-removal fix touched wireDocumentListeners's cc:session-closed
// handler only - unrelated to the Ctrl+N hint-badge wiring this spec covers)
// (sessions.css's .sessions-empty-row centering rules are unrelated to kbd-hint badges)

const S1 = sessionInstance({ session_id: "s1", cwd: "C:/Projects/aaa" });
const S2 = sessionInstance({ session_id: "s2", cwd: "C:/Projects/zzz" });

test("a reshuffled badge number doesn't replay the entrance while Ctrl stays held", async ({ page }) => {
  await mountSessionsList(page, [S1, S2]);
  const list = page.locator("#sessions-list");

  await page.keyboard.down("Control");
  await expect(list).toHaveClass(/kbd-hint-active/);
  await expect(list).toHaveClass(/kbd-hint-entering/);
  await expect(list.locator('li[data-kbd-hint="1"]')).toHaveAttribute("data-session-id", "s1");

  // Past KBD_HINT_ENTER_MS (300ms, sessions-dom-wiring.ts): the one-shot
  // entrance window has closed, but the badges stay up.
  await page.waitForTimeout(350);
  await expect(list).not.toHaveClass(/kbd-hint-entering/);
  await expect(list).toHaveClass(/kbd-hint-active/);

  // Simulate the reshuffle a Ctrl+N jump can cause: the next list_instances
  // answer swaps which session sorts first, handing badge "1" to the OTHER
  // session - on the same, still-mounted <li> nodes (reconcileList keeps
  // them; see sidebar-anim.ts's updateNode).
  await page.evaluate(([s1, s2]) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    };
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd: string, args?: Record<string, unknown>) =>
      cmd === "list_instances"
        ? Promise.resolve([{ ...s1, cwd: "C:/Projects/zzz2" }, { ...s2, cwd: "C:/Projects/aaa2" }])
        : orig(cmd, args);
  }, [S1, S2]);
  await fireEvent(page, "instances-changed", [null]);

  const firstHint = list.locator('li[data-kbd-hint="1"]');
  await expect(firstHint).toHaveAttribute("data-session-id", "s2");
  const animName = await firstHint.evaluate((li) => getComputedStyle(li, "::before").animationName);
  expect(animName).toBe("none");

  await page.keyboard.up("Control");
  await expect(list).not.toHaveClass(/kbd-hint-active/);
});
