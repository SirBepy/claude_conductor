import { expect, test } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// asserts: src/shared/chat/composer.css
// Phone composer: the one-line placeholder sat near the top of the input row
// instead of level with the send button beside it.

test("phone composer: an empty input's text line is centred on the send button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const sess = sessionInstance({ busy: false, awaiting: "done" });
  await mountView(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [sess], get_active_sessions: [sess] },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  const ta = page.locator("#session-pane .session-composer .composer-textarea").first();
  await ta.waitFor();

  const geo = await page.evaluate(() => {
    const pane = document.querySelector("#session-pane")!;
    const ta = pane.querySelector<HTMLElement>(".composer-textarea")!;
    const send = pane.querySelector<HTMLElement>(".composer-send")!;
    const s = getComputedStyle(ta);
    const r = ta.getBoundingClientRect();
    const lineTop = r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop);
    const lineCentre = lineTop + parseFloat(s.lineHeight) / 2;
    const sr = send.getBoundingClientRect();
    const hl = getComputedStyle(pane.querySelector<HTMLElement>(".composer-highlight")!);
    return {
      lineCentre,
      sendCentre: sr.top + sr.height / 2,
      taPad: `${s.paddingTop} ${s.paddingBottom}`,
      hlPad: `${hl.paddingTop} ${hl.paddingBottom}`,
    };
  });
  expect(Math.abs(geo.lineCentre - geo.sendCentre)).toBeLessThanOrEqual(1);
  // The backdrop paints the visible glyphs; it must move with the textarea.
  expect(geo.hlPad).toBe(geo.taPad);
});
