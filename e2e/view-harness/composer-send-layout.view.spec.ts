import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// Joe, 2026-10-30: Send leaves the input field and sits beside it as its own
// chip (same on desktop and phone); the phone's paperclip sits inside the field
// while the message is one line and stacks above Send once it wraps. All of it
// is geometry, so it is measured rather than screenshotted.

const PHONE = { width: 393, height: 852 };
const DESKTOP = { width: 1280, height: 800 };
const SESSION = sessionInstance();
const LONG =
  "Ship it, and tag the release. Also double check the changelog reads right and that nothing from the earlier branch slipped in.";

async function mountSession(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
}

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

for (const [name, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / composer send layout (${name})`, () => {
    test("Send sits outside the field and is exactly as tall as it", async ({ page }) => {
      await mountSession(page, size);
      const field = await box(page, "#session-pane .composer-row .composer-input-wrap");
      const send = await box(page, "#session-pane .composer-send");

      expect(send.x).toBeGreaterThanOrEqual(field.x + field.width);
      expect(Math.abs(send.height - field.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(send.y + send.height - (field.y + field.height))).toBeLessThanOrEqual(1);
      await expect(page.locator("#session-pane .composer-send-chevron")).toHaveCount(0);
    });

    test("an empty Send keeps a visible chip, and a draft fills it with the accent", async ({ page }) => {
      await mountSession(page, size);
      const send = page.locator("#session-pane .composer-send");
      const style = () => send.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, shadow: s.boxShadow };
      });

      const empty = await style();
      expect(empty.shadow).not.toBe("none");
      expect(empty.bg).not.toBe("rgba(0, 0, 0, 0)");

      await page.locator("#session-pane .composer-row .composer-textarea").fill("hello");
      await expect(send).toHaveClass(/composer-send--ready/);
      // Transition runs 150ms; wait it out rather than sampling mid-fade.
      await page.waitForTimeout(250);
      const ready = await style();
      expect(ready.bg).not.toBe(empty.bg);
    });
  });
}

test.describe("view-harness / composer paperclip (phone)", () => {
  test("desktop has no paperclip at all", async ({ page }) => {
    await mountSession(page, DESKTOP);
    await expect(page.locator("#session-pane .composer-attach")).toBeHidden();
    await expect(page.locator("#session-pane .composer-attach-in")).toBeHidden();
  });

  test("one line: the paperclip sits inside the field's right end", async ({ page }) => {
    await mountSession(page, PHONE);
    await page.locator("#session-pane .composer-row .composer-textarea").fill("short");

    const field = await box(page, "#session-pane .composer-row .composer-input-wrap");
    const clip = await box(page, "#session-pane .composer-attach-in");
    await expect(page.locator("#session-pane .composer-attach")).toBeHidden();
    expect(clip.x).toBeGreaterThanOrEqual(field.x);
    expect(clip.x + clip.width).toBeLessThanOrEqual(field.x + field.width + 1);
  });

  test("wrapped: the paperclip leaves the field and stacks above Send", async ({ page }) => {
    await mountSession(page, PHONE);
    await page.locator("#session-pane .composer-row .composer-textarea").fill(LONG);

    await expect(page.locator("#session-pane .composer-row")).toHaveClass(/composer-row--tall/);
    await expect(page.locator("#session-pane .composer-attach-in")).toBeHidden();
    const field = await box(page, "#session-pane .composer-row .composer-input-wrap");
    const clip = await box(page, "#session-pane .composer-attach");
    const send = await box(page, "#session-pane .composer-send");
    expect(clip.x).toBeGreaterThanOrEqual(field.x + field.width);
    expect(clip.y + clip.height).toBeLessThanOrEqual(send.y + 1);
  });

  test("clearing a long message puts the paperclip back inside the field", async ({ page }) => {
    await mountSession(page, PHONE);
    const ta = page.locator("#session-pane .composer-row .composer-textarea");
    await ta.fill(LONG);
    await expect(page.locator("#session-pane .composer-row")).toHaveClass(/composer-row--tall/);
    await ta.fill("");
    await expect(page.locator("#session-pane .composer-row")).not.toHaveClass(/composer-row--tall/);
    await expect(page.locator("#session-pane .composer-attach-in")).toBeVisible();
  });
});
