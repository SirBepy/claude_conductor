// Reviewed 2026-11-12 (project main chat): the initial load also reads the projects' main-chat pointers; it is awaited beside the list and a failed read keeps the old state, so the cache-first paint this spec asserts is unchanged, and it passes.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-05 (hidden subs): sidebar.ts now keeps a sub out of the unread marking and the favicon count; this spec's cached rows carry no subchat_of and it asserts the cache-first paint only, so its contract is unaffected and it passed after the change.
// Reviewed 2026-10-25 (project dashboard moved into new-chat drafts and a page opened from the chat header's project name; the Projects tab, Projects page and project page are gone): this spec drives none of those surfaces and passed after the change, so its contract is unaffected.
// asserts: src/views/sessions/sessions-initial-load.ts, src/views/sessions/sidebar.ts
import { test, expect } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, sessionInstance, mountViewPhone } from "./harness";

// The phone's tunnel drops often. A reopened app paints the chats list it saw
// last before list_instances answers, instead of a blank list behind it.

const ROW = sessionInstance({ session_id: "s-cached", name: "Cached chat row" });

test("a reloaded phone paints the last-known chats list while list_instances never answers", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await mountViewPhone(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [ROW], get_active_sessions: [ROW] },
  });
  await page.locator('#sessions-list li[data-session-id="s-cached"]').waitFor();

  // Registered after the harness's own route, so it runs first.
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as { method: string };
    if (body.method === "list_instances") return; // the tunnel never answers
    await route.fallback();
  });
  await page.reload();
  await expect(page.locator('#sessions-list li[data-session-id="s-cached"]')).toBeVisible({ timeout: 5000 });
});

test("a failed list_instances on the phone keeps the cached list instead of blanking it", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await mountViewPhone(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [ROW], get_active_sessions: [ROW] },
  });
  await page.locator('#sessions-list li[data-session-id="s-cached"]').waitFor();

  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as { method: string };
    if (body.method === "list_instances") return route.fulfill({ status: 502, json: { message: "tunnel down" } });
    await route.fallback();
  });
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('#sessions-list li[data-session-id="s-cached"]')).toBeVisible();
});
