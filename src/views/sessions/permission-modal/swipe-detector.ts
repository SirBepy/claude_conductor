// Shared touch-swipe detector for the question card's two independent
// gestures: question-swipe.ts pages horizontally, option-previews.ts steps
// a preview stage vertically. Both record a start point on a touch that
// passes their own `startsOn` gate, drop the gesture the moment the other
// axis dominates (so the sideways page-swipe and the vertical stage-swipe
// coexist on one card without stealing each other's drags), and fire once
// past `threshold` px along their own axis.

export interface SwipeOptions {
  /** Which signed delta decides direction and the threshold check. */
  axis: "x" | "y";
  /** Px of travel along `axis` before onSwipe fires. Default 40. */
  threshold?: number;
  /** Gate on the touchstart target; omit to start tracking on any single touch. */
  startsOn?: (target: Element) => boolean;
  /** direction is -1/+1 along `axis` (a negative delta means +1), matching
   *  both call sites' "swiped toward the next item" convention. startTarget
   *  is the element the gesture began on, for a caller that needs to
   *  resolve which instance (e.g. which question panel) the swipe belongs to. */
  onSwipe: (direction: 1 | -1, startTarget: Element) => void;
}

export function attachSwipe(host: HTMLElement, opts: SwipeOptions): void {
  const threshold = opts.threshold ?? 40;
  let active = false;
  let startX = 0;
  let startY = 0;
  let startTarget: Element | null = null;

  const onStart = (e: TouchEvent): void => {
    active = false;
    const t = e.touches[0];
    if (e.touches.length !== 1 || !t) return;
    const target = e.target as Element;
    if (opts.startsOn && !opts.startsOn(target)) return;
    active = true;
    startX = t.clientX;
    startY = t.clientY;
    startTarget = target;
  };

  const onMove = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!active || !t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const along = opts.axis === "x" ? dx : dy;
    const cross = opts.axis === "x" ? dy : dx;
    // A drag dominated by the other axis is left alone - this is what lets
    // a sibling detector on the other axis read the same gesture.
    if (Math.abs(cross) > Math.abs(along)) { active = false; return; }
    if (e.cancelable) e.preventDefault();
  };

  const onEnd = (e: TouchEvent): void => {
    if (!active) return;
    active = false;
    const t = e.changedTouches[0];
    if (!t || !startTarget) return;
    const delta = opts.axis === "x" ? t.clientX - startX : t.clientY - startY;
    if (Math.abs(delta) < threshold) return;
    opts.onSwipe(delta < 0 ? 1 : -1, startTarget);
  };

  host.addEventListener("touchstart", onStart, { passive: true });
  host.addEventListener("touchmove", onMove, { passive: false });
  host.addEventListener("touchend", onEnd);
  host.addEventListener("touchcancel", () => { active = false; });
}
