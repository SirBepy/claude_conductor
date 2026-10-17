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

// Applied to BOTH `root` (.view-sessions) and <html>: #modal-host
// (shared/modal.ts) mounts straight to document.body, a SIBLING of `root`,
// not a descendant - a var/attribute set only on `root` never cascades to
// it, which is why the project/model/location picker bottom sheets couldn't
// see the keyboard state and fell back to an unreliable dvh-only guess.
// <html> is an ancestor of both, so mirroring onto it covers both subtrees.
function clearKeyboardState(el: HTMLElement): void {
  el.removeAttribute("data-mobile-keyboard");
  el.style.removeProperty("--keyboard-inset");
}

function setKeyboardState(el: HTMLElement, open: boolean, inset: number): void {
  el.toggleAttribute("data-mobile-keyboard", open);
  el.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
}

function apply(): void {
  const root = _root;
  const vv = window.visualViewport;
  if (!root) return;
  if (!isMobileViewport() || !vv) {
    clearKeyboardState(root);
    clearKeyboardState(document.documentElement);
    return;
  }
  const layoutH = window.innerHeight;
  const visualH = vv.height + vv.offsetTop; // offsetTop: scroll keeps the focused field above the keyboard
  if (layoutH - visualH < 20) _closedBaseline = Math.max(_closedBaseline, layoutH);

  const open = _closedBaseline > 0 && _closedBaseline - visualH > OPEN_THRESHOLD;
  // Only the gap adjustResize left uncompensated - avoids double-pushing the composer.
  const stuckGap = Math.max(0, layoutH - visualH);
  const inset = open && stuckGap > OPEN_THRESHOLD ? stuckGap : 0;

  setKeyboardState(root, open, inset);
  setKeyboardState(document.documentElement, open, inset);
}

/** Wires the `.view-sessions` root to `visualViewport`; returns a detach
 *  function. Idempotent, mirrors initHeaderMerge. */
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
    clearKeyboardState(root);
    clearKeyboardState(document.documentElement);
    _root = null;
    _handler = null;
    _closedBaseline = 0;
  };
}
