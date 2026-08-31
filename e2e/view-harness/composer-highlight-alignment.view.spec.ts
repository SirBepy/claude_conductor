import { expect, test } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Todo 774: the colored backdrop sits behind a transparent-text textarea, so
// the two content boxes must agree to the pixel - a 1px border kept on one
// side alone shifts every glyph and wraps a just-fitting word early. Geometry
// rather than a screenshot: the drift is sub-glyph until it tips a wrap.

test("composer highlight backdrop and textarea share one content box", async ({ page }) => {
  const sess = sessionInstance({ busy: false, awaiting: "done" });
  await mountView(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [sess], get_active_sessions: [sess] },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-composer").first().waitFor();

  const geo = await page.evaluate(() => {
    const pane = document.querySelector("#session-pane")!;
    const box = (sel: string) => {
      const el = pane.querySelector(sel) as HTMLElement;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        textLeft: r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft),
        textTop: r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop),
        lineWidth: el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
        type: `${s.fontSize}/${s.lineHeight} ${s.fontFamily} ${s.letterSpacing} ${s.whiteSpace} ${s.overflowWrap}`,
      };
    };
    return { ta: box(".composer-textarea"), hl: box(".composer-highlight") };
  });

  expect(geo.hl.textLeft).toBeCloseTo(geo.ta.textLeft, 2);
  expect(geo.hl.textTop).toBeCloseTo(geo.ta.textTop, 2);
  expect(geo.hl.lineWidth).toBeCloseTo(geo.ta.lineWidth, 2);
  expect(geo.hl.type).toBe(geo.ta.type);
});
