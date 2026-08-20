// Phone on-screen keyboard: `visualViewport` shrinks when it opens regardless
// of Android's adjustResize/edge-to-edge behavior (todo 648). Drives a data
// attribute the header/statusbar/tab bar hide off, plus --keyboard-inset for
// when the layout viewport didn't resize itself (Joe, 2026-08-20).

import { isMobileViewport } from "./mobile-viewport";

const OPEN_THRESHOLD = 150; // px shrink from the "closed" baseline to call it "open"

let _root: HTMLElement | null = null;
let _handler: (() => void) | null = null;
// innerHeight can't be its own baseline under adjustResize (it shrinks WITH
// the keyboard) - re-baseline opportunistically on any full-height sighting.
let _closedBaseline = 0;

function apply(): void {
  const root = _root;
  const vv = window.visualViewport;
  if (!root) return;
  if (!isMobileViewport() || !vv) {
    root.removeAttribute("data-mobile-keyboard");
    root.style.removeProperty("--keyboard-inset");
    return;
  }
  const layoutH = window.innerHeight;
  const visualH = vv.height + vv.offsetTop; // offsetTop: scroll keeps the focused field above the keyboard
  if (layoutH - visualH < 20) _closedBaseline = Math.max(_closedBaseline, layoutH);

  const open = _closedBaseline > 0 && _closedBaseline - visualH > OPEN_THRESHOLD;
  // Only the gap adjustResize left uncompensated - avoids double-pushing the composer.
  const stuckGap = Math.max(0, layoutH - visualH);
  const inset = open && stuckGap > OPEN_THRESHOLD ? stuckGap : 0;

  root.toggleAttribute("data-mobile-keyboard", open);
  root.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
}

/** Wires the `.view-sessions` root to `visualViewport`; returns a detach
 *  function. Idempotent, mirrors initHeaderMerge/mountMobilePager. */
export function initMobileKeyboard(root: HTMLElement): () => void {
  _root = root;
  _closedBaseline = window.innerHeight;
  _handler = () => apply();
  const vv = window.visualViewport;
  vv?.addEventListener("resize", _handler);
  vv?.addEventListener("scroll", _handler);
  apply();
  return () => {
    if (_handler) {
      vv?.removeEventListener("resize", _handler);
      vv?.removeEventListener("scroll", _handler);
    }
    root.removeAttribute("data-mobile-keyboard");
    root.style.removeProperty("--keyboard-inset");
    _root = null;
    _handler = null;
    _closedBaseline = 0;
  };
}
