import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Soft-keyboard header behavior: visualViewport
// shrinking simulates the keyboard opening - no real IME in headless Chrome,
// but a viewport resize drives window.visualViewport identically to what an
// on-screen keyboard does, which is the only signal mobile-keyboard.ts reads.

const PHONE = { width: 393, height: 852 };
const KEYBOARD_HEIGHT = 400; // shrinks the viewport well past the 150px open threshold

const SESSION = sessionInstance();

async function mountPhoneSession(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
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
}

// Synthetic touches: the header swipe listens for touch events, which
// Playwright's mouse never produces.
async function swipe(page: Page, selector: string, dy: number, fromTopPx?: number): Promise<void> {
  await page.evaluate(({ selector, dy, fromTopPx }) => {
    const el = document.querySelector<HTMLElement>(selector)!;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = fromTopPx === undefined ? r.top + r.height / 2 : r.top + fromTopPx;
    const at = (cy: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: cy });
    el.dispatchEvent(new TouchEvent("touchstart", { touches: [at(y)], bubbles: true, cancelable: true }));
    el.dispatchEvent(new TouchEvent("touchmove", { touches: [at(y + dy)], bubbles: true, cancelable: true }));
    el.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
  }, { selector, dy, fromTopPx });
}

async function openKeyboard(page: Page): Promise<void> {
  await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD_HEIGHT });
  await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-keyboard", "");
}

test.describe("view-harness / mobile keyboard header", () => {
  test.use({ hasTouch: true });

  // Joe, 2026-10-05: the header + chip row stay by default (replacing the
  // 2026-08-20 always-unmount), and a swipe tucks/restores them.
  test("shrinking the viewport (keyboard open) keeps the header and chip row", async ({ page }) => {
    await mountPhoneSession(page);
    await openKeyboard(page);
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-keyboard", "");
    await expect(page.locator(".session-header")).toBeInViewport();
    await expect(page.locator(".session-statusbar")).toBeInViewport();
  });

  test("swipe up on the header tucks it and the chip row away; swipe down from the top restores", async ({ page }) => {
    await mountPhoneSession(page);
    await openKeyboard(page);
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-keyboard", "");

    await swipe(page, ".session-header", -80);
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-header-tucked", "");
    await expect(page.locator(".session-header")).not.toBeInViewport();
    await expect(page.locator(".session-statusbar")).not.toBeInViewport();

    await swipe(page, ".session-messages", 80, 8);
    await expect(page.locator(".view-sessions")).not.toHaveAttribute("data-mobile-header-tucked", "");
    await expect(page.locator(".session-header")).toBeInViewport();
  });

  test("a swipe down that starts mid-transcript does not restore the header", async ({ page }) => {
    await mountPhoneSession(page);
    await openKeyboard(page);
    await swipe(page, ".session-header", -80);
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-header-tucked", "");

    await swipe(page, ".session-messages", 80, 150);
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-header-tucked", "");
  });

  test("closing the keyboard clears the tuck, and the swipe is inert with it closed", async ({ page }) => {
    await mountPhoneSession(page);
    await openKeyboard(page);
    await swipe(page, ".session-header", -80);
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-header-tucked", "");

    await page.setViewportSize(PHONE);
    await expect(page.locator(".view-sessions")).not.toHaveAttribute("data-mobile-header-tucked", "");
    await swipe(page, ".session-header", -80);
    await expect(page.locator(".view-sessions")).not.toHaveAttribute("data-mobile-header-tucked", "");
    await expect(page.locator(".session-header")).toBeInViewport();
  });

  test("restoring the viewport (keyboard closed) brings the chrome back", async ({ page }) => {
    await mountPhoneSession(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD_HEIGHT });
    await expect(page.locator(".view-sessions")).toHaveAttribute("data-mobile-keyboard", "");

    await page.setViewportSize(PHONE);
    await expect(page.locator(".view-sessions")).not.toHaveAttribute("data-mobile-keyboard", "");
    await expect(page.locator(".session-header")).toBeVisible();
  });

  test("desktop width never sets the keyboard attribute", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [SESSION],
        get_active_sessions: [SESSION],
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      },
    });
    await page.locator("#sessions-list li[data-session-id]").first().click();
    await page.locator("#session-pane .session-composer").waitFor();

    await page.setViewportSize({ width: 1280, height: 400 });
    await expect(page.locator(".view-sessions")).not.toHaveAttribute("data-mobile-keyboard", "");
  });
});
