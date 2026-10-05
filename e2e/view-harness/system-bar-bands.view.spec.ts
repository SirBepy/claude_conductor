// asserts: src/styles/base.css
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The Android status and nav bars get their own bands via body padding
// (Joe, 2026-10-05). v0.2.113 shipped with the bands silently zeroed: the
// production bundle emits tauri_kit tokens.css's `html, body { padding: 0 }`
// AFTER base.css, while the dev server keeps import order, so only a build
// showed it. These pin the rule against that reset regardless of order.

const PHONE = { width: 393, height: 852 };
const TOP = 32;
const BOTTOM = 44;
const SESSION = sessionInstance();

async function mountPhoneWithInsets(page: Page): Promise<void> {
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
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: TOP, topMax: TOP, bottom: BOTTOM, bottomMax: BOTTOM },
  } as never);
  // The bundle's order: the kit reset lands after base.css.
  await page.addStyleTag({ content: "html, body { margin: 0; padding: 0; }" });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
}

test("body keeps both system-bar bands even with the kit reset loaded after it", async ({ page }) => {
  await mountPhoneWithInsets(page);
  const pad = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return { top: s.paddingTop, bottom: s.paddingBottom };
  });
  expect(pad).toEqual({ top: `${TOP}px`, bottom: `${BOTTOM}px` });
});

test("the chat header starts below the status band and the composer ends above the nav band", async ({ page }) => {
  await mountPhoneWithInsets(page);
  const header = (await page.locator(".session-header").boundingBox())!;
  const composer = (await page.locator(".composer-shell").boundingBox())!;
  expect(Math.round(header.y)).toBeGreaterThanOrEqual(TOP);
  expect(Math.round(composer.y + composer.height)).toBeLessThanOrEqual(PHONE.height - BOTTOM);
});
