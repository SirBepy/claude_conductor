// asserts: src/views/sessions/when-done-chip.ts, src/views/sessions/when-done-chip.css
import { test, expect } from "@playwright/test";
import { mountView, capture, SESSIONS_BASE_INVOKE } from "./harness";

// The header chip for an armed sleep/shutdown-when-done run: visible in the
// Chats header without opening any menu, with the postpone presets one click away.

const ARMED = {
  action: "shutdown",
  phase: "watching",
  countdown_remaining_secs: null,
  waiting_on: ["a", "b"],
  gave_up_reason: null,
  snoozed_until_unix_ms: null,
};

const BASE_INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [],
  get_active_sessions: [],
};

test.describe("view-harness / when-done header chip", () => {
  test("an armed run shows in the header and offers the postpone presets", async ({ page }) => {
    await mountView(page, { view: "sessions", invoke: { ...BASE_INVOKE, get_when_done_state: ARMED } });

    const chip = page.locator("#when-done-chip-host");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Shutdown when idle · 2 chats");
    await capture(page.locator(".view-sessions .view-header"), "when-done-chip-armed");

    await chip.locator("[data-when-done-chip]").click();
    const pop = page.locator(".when-done-popover");
    await expect(pop).toBeVisible();
    await expect(pop.locator(".smore-item")).toHaveText(["30 minutes", "1 hour", "3 hours", "Cancel"]);
    await capture(page, "when-done-chip-popover");
  });

  test("the countdown chip carries a one-click Postpone", async ({ page }) => {
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...BASE_INVOKE,
        get_when_done_state: { ...ARMED, phase: "countingDown", countdown_remaining_secs: 28, waiting_on: [] },
      },
    });
    const chip = page.locator("#when-done-chip-host");
    await expect(chip).toContainText("Shutdown in");
    await expect(chip.locator("[data-when-done-quick]")).toHaveText("Postpone 30 min");
    await capture(page.locator(".view-sessions .view-header"), "when-done-chip-countdown");
  });

  test("nothing armed shows no chip", async ({ page }) => {
    await mountView(page, { view: "sessions", invoke: { ...BASE_INVOKE, get_when_done_state: { ...ARMED, action: null, phase: "disarmed" } } });
    await page.locator("#viewMoreBtn").waitFor();
    await expect(page.locator("#when-done-chip-host")).toBeHidden();
  });
});
