import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance } from "./harness";

// Held-message cross-surface visibility (the "message waiting" ask): a row
// must show its held_count without the session being the open chat. Mirrors
// sidebar-row-style.view.spec.ts's mounting pattern. Post-604, every held
// marker is the avatar-corner badge (session-held-corner).

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

    await expect(page.locator('li[data-session-id="s1"] .session-held-corner')).toBeVisible();
    await expect(page.locator('li[data-session-id="s1"] .session-held-count')).toHaveText("2");
    await expect(page.locator('li[data-session-id="s2"] .session-held-corner')).toHaveCount(0);
  });

  test("a single queued message still shows the number, not just a dot", async ({ page }) => {
    await mountSessionsList(page, [instance({ held_count: 1 })]);
    await expect(page.locator('li[data-session-id="s1"] .session-held-count')).toHaveText("1");
  });

  test("held badge coexists with the attention badge without hiding either", async ({ page }) => {
    await mountSessionsList(page, [instance({ held_count: 3 })]);
    const row = page.locator('li[data-session-id="s1"]');
    // Simulate the parked-prompt attention state the same way
    // sidebar-row-style.view.spec.ts does - pendingPromptSessionIds is
    // module-internal state, not reachable through a mocked IPC call.
    await row.evaluate((li) => li.classList.add("needs-attention"));

    await expect(row).toHaveClass(/needs-attention/);
    await expect(row.locator(".session-held-corner")).toBeVisible();
    await expect(row.locator(".session-held-count")).toHaveText("3");
  });

  test("portrait row shows the held corner badge on the avatar", async ({ page }) => {
    await mountSessionsList(page, [instance({ held_count: 4 })]);
    const row = page.locator('li[data-session-id="s1"]');
    await expect(row).toHaveClass(/row-portrait/);
    await expect(row.locator(".session-held-corner")).toBeVisible();
    await expect(row.locator(".session-held-corner .session-held-count")).toHaveText("4");
  });
});
