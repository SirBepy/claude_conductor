// asserts: src/views/sessions/whats-new/whats-new.ts, src/views/sessions/whats-new/whats-new-state.ts, src/views/sessions/whats-new/whats-new.css, src/views/sessions/sessions-helpers.ts, src/shared/update-toast.ts, src/changelog/entries.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, waitForPaneSettled } from "./harness";

// The empty session screen's "What's new": a button at rest, the panel opened
// by it, and opened by itself on the first launch after an update. The update
// is driven through the real path: the stored last-seen version differs from
// the version the mocked backend reports.

// The entries file is read as text (it imports PNGs, which node cannot load), so
// the next release's entry never turns this spec red.
const VERSIONS = [...readFileSync(path.join(process.cwd(), "src", "changelog", "entries.ts"), "utf8").matchAll(/^ {4}version: "([^"]+)"/gm)].map((m) => m[1]!);
const [LATEST, PREVIOUS] = VERSIONS as [string, string];
const stepBack = (v: string): string => { const [a, b, c] = v.split(".").map(Number); return `${a}.${b}.${Math.max(0, c! - 1)}`; };

async function mountEmpty(page: Page, opts: { lastSeen: string | null; running: string }): Promise<void> {
  // Seeded only when absent, so a reload is the "second launch" with whatever
  // the first launch stored.
  await page.addInitScript(({ lastSeen }) => {
    try {
      if (lastSeen && localStorage.getItem("lastSeenAppVersion") === null) localStorage.setItem("lastSeenAppVersion", lastSeen);
    } catch { /* storage blocked */ }
  }, { lastSeen: opts.lastSeen });
  await mountView(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [], get_active_sessions: [], is_daemon_connected: true, get_app_version: opts.running },
  });
  if ((page.viewportSize()?.width ?? 1280) <= 768) {
    // At phone width the empty pane is hidden behind the chat list unless the
    // chat pane is raised; a phone never shows it empty (docs/architecture/release-shape.md (What's new section)).
    await page.locator(".view-sessions").evaluate((el) => el.setAttribute("data-mobile-pane", "chat"));
  }
  await expect(page.locator("#session-pane .session-empty--home")).toBeVisible();
}

const panel = (page: Page) => page.locator("#session-pane .wn-panel");
const button = (page: Page) => page.locator("#session-pane .wn-btn");

test.describe("What's new on the empty session screen", () => {
  test("no update: a What's new button, and the button opens a picture grid that Close puts away", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await mountEmpty(page, { lastSeen: LATEST, running: LATEST });
    await expect(page.locator("#session-pane .session-empty-line")).toHaveText("Select or create a session");
    await expect(button(page)).toContainText("What's new");
    await expect(button(page)).toContainText(`v${LATEST}`);
    await expect(panel(page)).toHaveCount(0);
    await page.waitForTimeout(700); // view-enter fade
    await capture(page, "whats-new-1-button");

    await button(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator("h2")).toHaveText(`What's new in v${LATEST}`);
    expect(await panel(page).locator(".wn-card").count()).toBeGreaterThan(0);
    for (const img of await panel(page).locator(".wn-shot").all()) {
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
    }

    await panel(page).locator(`.wn-tab[data-wn-version="${PREVIOUS}"]`).click();
    await expect(panel(page).locator("h2")).toHaveText(`What's new in v${PREVIOUS}`);

    await panel(page).locator("[data-wn='close']").click();
    await expect(panel(page)).toHaveCount(0);
    await expect(button(page)).toBeVisible();
    // The button names the newest release, not the tab that was last looked at.
    await expect(button(page)).toContainText(`v${LATEST}`);
  });

  test("first launch after an update opens the panel by itself, the next launch does not", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await mountEmpty(page, { lastSeen: stepBack(LATEST), running: LATEST });
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator("h2")).toHaveText(`What's new in v${LATEST}`);
    await expect(button(page)).toHaveCount(0);
    await page.locator("#session-pane .wn-card").first().waitFor();
    await page.waitForTimeout(700); // view-enter fade and the grow-in
    await capture(page, "whats-new-2-after-update");
    // Still on screen after a moment: that is what spends the flag.
    await expect.poll(() => page.evaluate(() => localStorage.getItem("whatsNewPendingVersion"))).toBeNull();

    await page.reload();
    await expect(page.locator("#session-pane .session-empty--home")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(button(page)).toBeVisible();
  });

  test("a fresh install records the version and shows no changelog", async ({ page }) => {
    await mountEmpty(page, { lastSeen: null, running: LATEST });
    await expect(button(page)).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test("an update to a version with no entry opens nothing, the button still works", async ({ page }) => {
    await mountEmpty(page, { lastSeen: LATEST, running: "99.9.999" });
    await expect(button(page)).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await button(page).click();
    await expect(panel(page)).toBeVisible();
  });

  test("narrow pane: one picture per row", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await mountEmpty(page, { lastSeen: stepBack(LATEST), running: LATEST });
    await expect(panel(page)).toBeVisible();
    await waitForPaneSettled(page);
    const boxes = await panel(page).locator(".wn-card").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
    expect(boxes.length).toBeGreaterThan(1);
    expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.bottom - 1);
    expect(boxes[0]!.right).toBeLessThanOrEqual(390);
    expect(boxes[0]!.left).toBeGreaterThanOrEqual(0);
    await page.waitForTimeout(700);
    await capture(page, "whats-new-3-phone");
  });
});
