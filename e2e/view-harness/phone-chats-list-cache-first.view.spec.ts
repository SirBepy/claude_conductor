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
