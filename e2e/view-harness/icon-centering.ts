import { expect, type Page } from "@playwright/test";

// An icon-only button whose glyph sits off its centre is a bug class that has
// recurred across the app (bef3e1b2, 48630ab6, 45a98aa2, the question card's
// Ask button): a surface rule swaps `display` on a shared button class and
// silently drops the base rule's centring. Asserting per button only catches
// the one that already broke, so this sweeps every visible icon-only button
// under a root and names each one whose glyph is off by more than TOLERANCE_PX.

const TOLERANCE_PX = 1.5;

export interface OffCentre {
  button: string;
  dx: number;
  dy: number;
}

/** Visible buttons whose only content is one Phosphor `<i>`, with the glyph's
 *  offset from the centre of the button's box inside its border. Buttons carrying a count/dot
 *  mark or any text are skipped: their icon is not meant to be centred alone. */
export async function offCentreIconButtons(page: Page, root = "body"): Promise<{ checked: number; off: OffCentre[] }> {
  return page.evaluate(
    ({ root, tol }) => {
      const out: { button: string; dx: number; dy: number }[] = [];
      let checked = 0;
      const scope = document.querySelector(root);
      if (!scope) return { checked, off: out };
      for (const btn of scope.querySelectorAll<HTMLElement>("button, [role='button']")) {
        const icon = btn.firstElementChild;
        if (!icon || btn.childElementCount !== 1 || icon.tagName !== "I" || !/\bph\b|\bph-/.test(icon.className)) continue;
        if ((btn.textContent ?? "").trim() !== "") continue;
        const b = btn.getBoundingClientRect();
        const g = icon.getBoundingClientRect();
        if (b.width === 0 || b.height === 0 || g.width === 0) continue;
        const cs = getComputedStyle(btn);
        if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
        checked++;
        // Inside the border, padding included: the eye centres on the visible
        // box, and a stray padding (the bare `button {}` rule's 7px 16px in
        // color-picker.css) is exactly what shoves a glyph sideways.
        const left = b.left + parseFloat(cs.borderLeftWidth);
        const right = b.right - parseFloat(cs.borderRightWidth);
        const top = b.top + parseFloat(cs.borderTopWidth);
        const bottom = b.bottom - parseFloat(cs.borderBottomWidth);
        const dx = (g.left + g.right) / 2 - (left + right) / 2;
        const dy = (g.top + g.bottom) / 2 - (top + bottom) / 2;
        if (Math.abs(dx) <= tol && Math.abs(dy) <= tol) continue;
        const id = btn.dataset.act ?? btn.getAttribute("aria-label") ?? btn.title ?? "";
        out.push({
          button: `${btn.className || btn.tagName.toLowerCase()} [${id}] <i class="${icon.className}">`,
          dx: Math.round(dx * 10) / 10,
          dy: Math.round(dy * 10) / 10,
        });
      }
      return { checked, off: out };
    },
    { root, tol: TOLERANCE_PX },
  );
}

/** Fails on any off-centre glyph, and on a sweep that found no icon-only
 *  button at all (a route that never rendered would otherwise pass). */
export async function expectIconButtonsCentred(page: Page, root = "body"): Promise<void> {
  // Polled: under a loaded parallel run a route can still be painting.
  await expect.poll(async () => (await offCentreIconButtons(page, root)).checked).toBeGreaterThan(0);
  expect((await offCentreIconButtons(page, root)).off).toEqual([]);
}
