import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance } from "./harness";

// Replaces the marker-based `e2e/specs/close-teardown.e2e.js` (ai_todo 147).
// The daemon SETS `Instance.closing` (pump.rs:155-158, Rust-tested); this
// asserts the sidebar reads it. Mocked daemon, so no billed /close turn.

function instance(over: Parameters<typeof sessionInstance>[0] = {}) {
  return sessionInstance({
    cwd: "C:/Projects/claude_usage_in_taskbar", started_at: "2026-07-30T10:00:00Z", name: "A session",
    ...over,
  });
}

/** Segment 3 ("Closing") is collapsed by default (sessions-helpers.ts:338), so
 *  its rows are not in the DOM until the group header is clicked. */
async function expandClosingGroup(page: import("@playwright/test").Page): Promise<void> {
  await page.locator('#sessions-list li[data-seg-toggle="3"]').click();
}

test.describe("view-harness / daemon-authoritative close lifecycle", () => {
  test("a closing instance raises the Closing group, an idle one does not", async ({ page }) => {
    await mountSessionsList(page, [
      instance({ session_id: "shutting-down", name: "Closing session", closing: true }),
      instance({ session_id: "idle", name: "Idle session", closing: false }),
    ], "classic");

    // Driven purely by the daemon's broadcast flag, no text marker anywhere.
    const header = page.locator('#sessions-list li[data-seg-toggle="3"]');
    await expect(header).toBeVisible();
    await expect(header).toContainText("Closing");
    await expect(page.locator('li[data-session-id="idle"]')).toBeVisible();
  });

  test("no session closing means no Closing group at all", async ({ page }) => {
    await mountSessionsList(page, [instance({ session_id: "idle", closing: false })], "classic");
    await expect(page.locator('#sessions-list li[data-seg-toggle="3"]')).toHaveCount(0);
  });

  test("the expanded row carries the closing class", async ({ page }) => {
    await mountSessionsList(page, [
      instance({ session_id: "shutting-down", name: "Closing session", closing: true }),
      instance({ session_id: "idle", name: "Idle session", closing: false }),
    ], "classic");
    await expandClosingGroup(page);

    await expect(page.locator('li[data-session-id="shutting-down"]')).toHaveClass(/closing/);
    await expect(page.locator('li[data-session-id="idle"]')).not.toHaveClass(/closing/);
  });

  test("portrait rows swap the status dot to st-closing", async ({ page }) => {
    await mountSessionsList(page, [
      instance({ session_id: "shutting-down", name: "Closing session", closing: true }),
      instance({ session_id: "idle", name: "Idle session", closing: false }),
    ], "portrait");
    await expandClosingGroup(page);

    // sidebar-rows.ts:172 - closing overrides the normal status colour, and the
    // idle row must keep reading its own pre-closing class.
    await expect(page.locator('li[data-session-id="shutting-down"] .avatar-status-dot')).toHaveClass(/st-closing/);
    await expect(page.locator('li[data-session-id="idle"] .avatar-status-dot')).not.toHaveClass(/st-closing/);
  });

  test("a torn-down session leaves the live list once the daemon reports it ended", async ({ page }) => {
    // mark_ended drops it from the live set - what the old spec watched for.
    await mountSessionsList(page, [
      instance({ session_id: "shutting-down", closing: true }),
      instance({
        session_id: "gone", name: "Torn down", closing: false,
        ended_at: "2026-07-30T11:00:00Z", end_reason: "manual",
      }),
    ], "classic");

    await expect(page.locator('#sessions-list li[data-seg-toggle="3"]')).toBeVisible();
    await expect(page.locator('li[data-session-id="gone"]')).toHaveCount(0);
  });
});
