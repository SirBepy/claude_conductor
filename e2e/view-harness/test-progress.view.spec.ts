// Reviewed 2026-11-21 (Run card and opened sub view tabs): chat-dashboard.ts, dashboard-zones.ts, dashboard-extras.css and subs-card.ts changed for the Run card's after names and the sub view's Plan and Attachments tabs; nothing this spec asserts changed, and it passes (run of every dependent spec).
// asserts: src/views/sessions/chat-dashboard/test-progress-card.ts, src/views/sessions/chat-dashboard/test-progress-card.css, src/shared/chat/dashboard/test-progress-model.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts

// The dashboard's Test progress card (pc-1684) in the real app shell, dark and light: a
// `test-progress` event draws one row per runner with a bar, counts and the failing tests'
// names; a tick patches those in place (the node stays, the bar fills by transition); the
// card raises nothing in Waiting on you; a finished run can be dismissed; and the Settings
// switch hides it. The daemon route and the wrapper script are covered by their own tests.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

const SESSION = sessionInstance({ session_id: "main", name: "Tests", pid: 101 });
const HISTORY = [userMsg("run the tests")];
const EMPTY_STORE = { read: {}, threads: {}, questions: [], rewrites: {} };

const run = (over: Record<string, unknown> = {}) => ({
  runner: "vitest", passed: 0, failed: 0, total: 0, failing: [], failing_more: 0, state: "running", at_ms: 1, ...over,
});
const report = (runs: unknown[], sid = "main") => ({ session_id: sid, runs });

async function open(page: Page, theme: string, sections?: Record<string, boolean>): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { theme, ...(sections ? { dashboardSections: sections } : {}) },
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      answers_state: EMPTY_STORE, ask_list_threads: [], answers_mark: EMPTY_STORE,
      list_message_drafts: { drafts: [], people: [] },
      list_previews: [],
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.waitForFunction(() => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get("test-progress")?.size ?? 0) > 0;
  });
  await page.locator("#session-pane .cdash").waitFor();
}

const card = (page: Page): Locator => page.locator("#session-pane .cdash-tests");
const rowOf = (page: Page, runner: string): Locator => card(page).locator(`.tp-run[data-tp="${runner}"]`);
const fire = (page: Page, runs: unknown[], sid?: string) => fireEvent(page, "test-progress", [report(runs, sid)]);

for (const [theme, mode] of [["void", "dark"], ["void-light", "light"]] as const) {
  test.describe(`chat dashboard / Test progress card (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
    });

    test("a chat that never ran tests has no card", async ({ page }) => {
      await expect(card(page)).toHaveCount(0);
      // Another chat's report is not this chat's.
      await fire(page, [run({ passed: 3 })], "someone-else");
      await expect(card(page)).toHaveCount(0);
    });

    test("sits in the right column under Plan and fills in as a run reports", async ({ page }) => {
      await fire(page, [run({ passed: 40, total: 100 })]);
      await expect(card(page)).toBeVisible();
      // Its place under Plan is the model's ZONES order (covered in tests/); here it is in the right column.
      await expect(page.locator("#session-pane .cdash-right .cdash-tests")).toHaveCount(1);
      const row = rowOf(page, "vitest");
      await expect(row.locator(".tp-chip")).toHaveText("Running");
      await expect(row.locator(".tp-pass")).toHaveText("40 passed");
      await expect(row.locator(".tp-of-in")).toHaveText("of 100");
      await expect(row.locator(".tp-ok")).toHaveCSS("transform", /matrix\(0\.4, 0, 0, 1, 0, 0\)/);
      await fire(page, [run({ passed: 90, failed: 3, total: 100, failing: ["parser > rejects tabs", "parser > keeps order"] })]);
      await expect(row.locator(".tp-fail-in")).toHaveText("3 failed");
      await expect(row.locator(".tp-f .tp-fn")).toHaveText(["parser > rejects tabs", "parser > keeps order"]);
      await capture(page.locator("#session-pane"), `test-progress-running-${mode}`);
      await fire(page, [run({ passed: 97, failed: 3, total: 100, failing: ["parser > rejects tabs", "parser > keeps order"], state: "failed", at_ms: 2 })]);
      await expect(row.locator(".tp-chip")).toHaveText("Failed");
      await expect(row).toHaveAttribute("data-state", "failed");
      await capture(page.locator("#session-pane"), `test-progress-failed-${mode}`);
    });

    test("a tick patches in place: the row, the bar and the failing rows stay the same nodes", async ({ page }) => {
      await fire(page, [run({ passed: 10, total: 100, failed: 1, failing: ["a > b"] })]);
      const row = rowOf(page, "vitest");
      await expect(row.locator(".tp-pass")).toHaveText("10 passed");
      await row.evaluate((el) => {
        (el as HTMLElement & { __mark?: string }).__mark = "same";
        (el.querySelector(".tp-ok") as HTMLElement & { __mark?: string }).__mark = "same";
        (el.querySelector(".tp-f") as HTMLElement & { __mark?: string }).__mark = "same";
      });
      await fire(page, [run({ passed: 60, total: 100, failed: 1, failing: ["a > b"], at_ms: 2 })]);
      await expect(row.locator(".tp-pass")).toHaveText("60 passed");
      const marks = await row.evaluate((el) => [
        (el as HTMLElement & { __mark?: string }).__mark,
        (el.querySelector(".tp-ok") as HTMLElement & { __mark?: string }).__mark,
        (el.querySelector(".tp-f") as HTMLElement & { __mark?: string }).__mark,
      ]);
      expect(marks).toEqual(["same", "same", "same"]);
      // The fill is a transition from the last scale, not a jump.
      const dur = await row.locator(".tp-ok").evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(parseFloat(dur)).toBeGreaterThan(0);
    });

    test("a run with no total shows a sweep, then fills to what ran when it ends", async ({ page }) => {
      await fire(page, [run({ passed: 12 })]);
      const row = rowOf(page, "vitest");
      await expect(row).toHaveClass(/is-indet/);
      await expect(row.locator(".tp-bar")).toHaveCSS("overflow", "hidden");
      await fire(page, [run({ passed: 20, total: 20, state: "passed", at_ms: 2 })]);
      await expect(row).not.toHaveClass(/is-indet/);
      await expect(row.locator(".tp-chip")).toHaveText("Passed");
      await expect(row.locator(".tp-ok")).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, 0\)/);
    });

    test("two runners are two rows, and a failed test raises nothing in Waiting on you", async ({ page }) => {
      const stripBefore = await page.locator("#session-pane .cdash-strip").evaluate((el) => `${el.hasAttribute("hidden")}|${el.textContent}`);
      await fire(page, [run({ passed: 5, total: 10 }), run({ runner: "cargo test", passed: 7, failed: 2, total: 20, failing: ["daemon::route::caps"], state: "failed", at_ms: 2 })]);
      await expect(card(page).locator(".tp-run")).toHaveCount(2);
      await expect(page.locator("#session-pane .cdash-waiting")).toHaveCount(0);
      await expect(page.locator("#session-pane .cdash-alert")).toHaveCount(0);
      expect(await page.locator("#session-pane .cdash-strip").evaluate((el) => `${el.hasAttribute("hidden")}|${el.textContent}`)).toBe(stripBefore);
    });

    test("hovering a finished run leaves its box unchanged and shows the dismiss x over the top line", async ({ page }) => {
      await fire(page, [run({ passed: 20, total: 20, state: "passed" })]);
      const row = rowOf(page, "vitest");
      const x = row.locator(".tp-x");
      await expect(row.locator(".tp-chip")).toHaveText("Passed");
      // The row folds open on entry; measure once it has settled.
      await expect(row).not.toHaveClass(/is-new/);
      await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeGreaterThan(60);
      await page.waitForTimeout(400);
      const rest = await row.boundingBox();
      const topRest = await row.locator(".tp-top").boundingBox();
      await expect(x).toHaveCSS("opacity", "0");
      await row.hover();
      await expect(x).toHaveCSS("opacity", "1");
      expect(await row.boundingBox()).toEqual(rest);
      expect(await row.locator(".tp-top").boundingBox()).toEqual(topRest);
    });

    test("a running run has no x, and a finished one is dismissed with a fold and stays gone", async ({ page }) => {
      await fire(page, [run({ passed: 5, total: 20 })]);
      const row = rowOf(page, "vitest");
      await expect(row.locator(".tp-x")).toBeHidden();
      await fire(page, [run({ passed: 20, total: 20, state: "passed", at_ms: 5 })]);
      await row.hover();
      await row.locator(".tp-x").click();
      await expect(card(page)).toHaveCount(0);
      // The daemon resends the old report next to another runner's: only the other shows.
      await fire(page, [run({ passed: 20, total: 20, state: "passed", at_ms: 5 }), run({ runner: "cargo test", passed: 1, total: 4, at_ms: 6 })]);
      await expect(card(page).locator(".tp-run")).toHaveCount(1);
      await expect(rowOf(page, "cargo test")).toBeVisible();
    });
  });
}

test("the Settings switch hides the card", async ({ page }) => {
  await open(page, "void", { tests: false });
  await fire(page, [run({ passed: 3, total: 9 })]);
  await expect(card(page)).toHaveCount(0);
});
