// Reviewed 2026-11-12 (honest sub states): subs gained queued/paused/usage-limit/stopped kinds with a dim ring and glyph, an avatar hover card, the Plan foot's sub counts and a glowing main-chat ring; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// asserts: src/views/sessions/sidebar.ts, src/views/sessions/sidebar-rows.ts, src/views/sessions/sidebar-entries.ts
import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance } from "./harness";

// Sorting by token drain puts a "% of 5h" chip on every row. A plan with no 5h
// limit (`five_hour_limited: false`) has no such window, so its chats must draw
// no chip while a chat on a limited plan keeps it.

const snap = (limited: boolean) => ({
  captured_at: "2026-11-07T10:00:00Z",
  five_hour: limited
    ? { utilization: 30, resets_at: "2099-01-01T00:00:00Z" }
    : { utilization: 0, resets_at: null },
  five_hour_limited: limited,
  seven_day: { utilization: 20, resets_at: "2099-01-05T00:00:00Z" },
});

const chat = (id: string, accountId: string) =>
  sessionInstance({ session_id: id, cwd: "C:/Projects/alpha", name: `Chat ${id}`, account_id: accountId });

test.describe("view-harness / sidebar drain chip on a plan without a 5h window", () => {
  test("the chip is absent for a no-5h-window account and present for a limited one", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("cc_session_sort", "drain"));
    await mountSessionsList(page, [chat("s1", "free"), chat("s2", "max")], {
      get_usage_map: { free: snap(false), max: snap(true) },
      chat_drains: { chats: {
        s1: { sessionId: "s1", fiveHourPct: 12.4 },
        s2: { sessionId: "s2", fiveHourPct: 12.4 },
      } },
    });

    // The limited chat's chip resolving proves the drain and usage reads both
    // landed, so the other row's absence is the gate and not a pending fetch.
    await expect(page.locator('li[data-session-id="s2"] .session-row-drain')).toHaveText("12% of 5h");
    await expect(page.locator('li[data-session-id="s1"]')).toBeVisible();
    await expect(page.locator('li[data-session-id="s1"] .session-row-drain')).toHaveCount(0);
  });
});
