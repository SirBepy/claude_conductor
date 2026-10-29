// Reviewed 2026-10-29: session-header.css gained the .is-swapping title crossfade; this spec asserts the project chip only, so its contract is unaffected. Passed after the change.
// asserts: src/views/sessions/session-header.css
import { test, expect } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// On desktop the header text is a two-column grid; the project name sits in
// the wide first column. Its hover background must hug the name like a chip,
// not stretch across the column to where model+effort sit.

const SESSION = sessionInstance();

test("desktop header's project name is only as wide as its text", async ({ page }) => {
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
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);

  const proj = page.locator("#session-pane .session-header .meta-proj");
  await expect(proj).not.toHaveText("");
  const { projWidth, textWidth, columnWidth } = await proj.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const header = el.closest(".session-header-text")!;
    return {
      projWidth: el.getBoundingClientRect().width,
      textWidth: range.getBoundingClientRect().width,
      columnWidth: header.getBoundingClientRect().width,
    };
  });
  // Padding adds a few px around the text; a stretched element would be the
  // whole column, hundreds of px wider.
  expect(projWidth).toBeLessThanOrEqual(textWidth + 12);
  expect(projWidth).toBeLessThan(columnWidth / 2);
});
