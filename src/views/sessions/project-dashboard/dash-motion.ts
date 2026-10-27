// Motion for the dashboard inside a new-chat draft: its sections arrive as one
// wave from the top, and on the first send the whole thing fades and folds
// away. Web Animations rather than CSS classes: lit re-renders and the
// column rebalance move nodes, and a class-driven animation would replay on
// every move, while a WAAPI animation belongs to the element for good.

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_IN_OUT = "cubic-bezier(0.32, 0.72, 0, 1)";
const ENTER_MS = 420;
const STEP_MS = 45;
// Past this the last section would still be arriving after the user has
// started reading the first, so deep dashboards share the tail of the wave.
const MAX_DELAY_MS = 270;
const RISE_PX = 10;
const LEAVE_MS = 220;
const REDUCED_MS = 140;

const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const canAnimate = (el: HTMLElement): boolean => typeof el.animate === "function";

/** Every section and the chip row, in the order the eye reads them: down the
 *  page, left before right at the same height. DOM order would finish the
 *  whole left column before the right one starts. */
export function entranceOrder(targets: HTMLElement[]): HTMLElement[] {
  const top = new Map<HTMLElement, { y: number, x: number }>();
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    top.set(el, { y: r.top, x: r.left });
  }
  return [...targets].sort((a, b) => {
    const pa = top.get(a)!;
    const pb = top.get(b)!;
    // Heights in two columns only roughly line up; a few px is the same row.
    return Math.abs(pa.y - pb.y) > 6 ? pa.y - pb.y : pa.x - pb.x;
  });
}

/** Staggers the dashboard's sections in. Content is already laid out and
 *  visible underneath, so a failed animation leaves a normal dashboard. */
export function playEntrance(root: HTMLElement, chips: HTMLElement): void {
  const targets = [...root.querySelectorAll<HTMLElement>(".pd-reports, .pd-top > *, .pd-col > *, .pd-bottom > *"), ...chips.querySelectorAll<HTMLElement>(".pd-qa")]
    .filter((el) => canAnimate(el) && el.offsetHeight > 0);
  if (targets.length === 0) return;
  const reduced = reducedMotion();
  entranceOrder(targets).forEach((el, i) => {
    el.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: `translateY(${RISE_PX}px)` }, { opacity: 1, transform: "none" }],
      {
        duration: reduced ? REDUCED_MS : ENTER_MS,
        delay: reduced ? 0 : Math.min(i * STEP_MS, MAX_DELAY_MS),
        easing: EASE_OUT,
        // Hidden through its own delay, not just once it starts.
        fill: "backwards",
      },
    );
  });
}

/** Fades a detached copy of a dashboard part out and folds its height to
 *  nothing, so whatever sits below it glides up instead of jumping. Removes
 *  the copy when done. */
export function fadeOutAndFold(ghost: HTMLElement): void {
  const remove = (): void => ghost.remove();
  if (!canAnimate(ghost)) { remove(); return; }
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.pointerEvents = "none";
  ghost.style.boxSizing = "border-box";
  ghost.style.overflow = "hidden";
  const reduced = reducedMotion();
  const cs = getComputedStyle(ghost);
  const frames: Keyframe[] = reduced
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [
        { opacity: 1, height: `${ghost.offsetHeight}px`, marginTop: cs.marginTop, marginBottom: cs.marginBottom },
        { opacity: 0, height: "0px", marginTop: "0px", marginBottom: "0px" },
      ];
  const anim = ghost.animate(frames, { duration: reduced ? REDUCED_MS : LEAVE_MS, easing: EASE_IN_OUT, fill: "forwards" });
  anim.onfinish = remove;
  anim.oncancel = remove;
}
