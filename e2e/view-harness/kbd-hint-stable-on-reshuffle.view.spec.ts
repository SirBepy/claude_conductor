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
