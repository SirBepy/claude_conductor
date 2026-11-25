// Reviewed 2026-11-25 (model and effort are words, not battery glyphs; the desktop chat header is one line with one text chip): nothing this spec asserts changed, and it passes in the full view-suite run.
// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-21 (the open chat's viewed mark is renewed every minute by a heartbeat in chat-seen.ts, started from sidebar.ts): nothing this spec asserts changed, and it passes in the run of every spec that depends on sidebar.ts.
// Reviewed 2026-11-16 (chat heads, pc-1769): the Closing group is a closing class and ring on the head.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/sidebar.ts
import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance } from "./harness";

// Replaces the marker-based `e2e/specs/close-teardown.e2e.js` (ai_todo 147).
// The daemon SETS `Instance.closing` (pump.rs:155-158, Rust-tested); this
// asserts the sidebar reads it. Mocked daemon, so no real held close.

function instance(over: Parameters<typeof sessionInstance>[0] = {}) {
  return sessionInstance({
    cwd: "C:/Projects/claude_usage_in_taskbar", started_at: "2026-07-30T10:00:00Z", name: "A session",
    ...over,
  });
}

test.describe("view-harness / daemon-authoritative close lifecycle", () => {
  test("a closing instance's head is marked closing, an idle one is not", async ({ page }) => {
    await mountSessionsList(page, [
      instance({ session_id: "shutting-down", name: "Closing session", closing: true }),
      instance({ session_id: "idle", name: "Idle session", closing: false }),
    ]);

    // Driven purely by the daemon's broadcast flag, no text marker anywhere.
    await expect(page.locator('li[data-session-id="shutting-down"]')).toHaveClass(/closing/);
    await expect(page.locator('li[data-session-id="idle"]')).toBeVisible();
    await expect(page.locator('li[data-session-id="idle"]')).not.toHaveClass(/closing/);
  });

  test("no session closing means no head is marked closing", async ({ page }) => {
    await mountSessionsList(page, [instance({ session_id: "idle", closing: false })]);
    await expect(page.locator('li[data-session-id="idle"]')).toBeVisible();
    await expect(page.locator("#sessions-list li.closing")).toHaveCount(0);
  });

  test("the closing head carries the closing class", async ({ page }) => {
    await mountSessionsList(page, [
      instance({ session_id: "shutting-down", name: "Closing session", closing: true }),
      instance({ session_id: "idle", name: "Idle session", closing: false }),
    ]);

    await expect(page.locator('li[data-session-id="shutting-down"]')).toHaveClass(/closing/);
    await expect(page.locator('li[data-session-id="idle"]')).not.toHaveClass(/closing/);
  });

  test("a closing head carries st-closing on its li and draws no ring", async ({ page }) => {
    await mountSessionsList(page, [
      instance({ session_id: "shutting-down", name: "Closing session", closing: true }),
      instance({ session_id: "idle", name: "Idle session", closing: false }),
    ]);

    // chat-heads.ts's head builder - closing overrides the normal status class, and the
    // idle row must keep reading its own pre-closing class. A head draws no status ring.
    await expect(page.locator('li[data-session-id="shutting-down"]')).toHaveAttribute("data-st", "st-closing");
    await expect(page.locator('li[data-session-id="idle"]')).not.toHaveAttribute("data-st", "st-closing");
    await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
  });

  test("a torn-down session leaves the live list once the daemon reports it ended", async ({ page }) => {
    // mark_ended drops it from the live set - what the old spec watched for.
    await mountSessionsList(page, [
      instance({ session_id: "shutting-down", closing: true }),
      instance({
        session_id: "gone", name: "Torn down", closing: false,
        ended_at: "2026-07-30T11:00:00Z", end_reason: "manual",
      }),
    ]);

    await expect(page.locator('li[data-session-id="shutting-down"]')).toBeVisible();
    await expect(page.locator('li[data-session-id="gone"]')).toHaveCount(0);
  });
});
