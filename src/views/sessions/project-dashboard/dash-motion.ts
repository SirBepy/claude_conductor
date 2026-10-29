// Motion for the dashboard inside a new-chat draft: its sections arrive as one
// wave from the top, and on the first send the whole thing fades and folds
// away. Web Animations rather than CSS classes: lit re-renders and the
// column rebalance move nodes, and a class-driven animation would replay on
// every move, while a WAAPI animation belongs to the element for good.

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_IN_OUT = "cubic-bezier(0.32, 0.72, 0, 1)";
// Slow on purpose: at a quarter of these durations the stagger read as a
// flicker, not as a wave moving down the page.
const ENTER_MS = 1680;
const STEP_MS = 180;
// Past this the last section would still be arriving after the user has
// started reading the first, so deep dashboards share the tail of the wave.
const MAX_DELAY_MS = 1080;
const RISE_PX = 10;
const LEAVE_MS = 880;
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

export interface Entrance {
  /** Brings in any section that appeared since the wave started. */
  catchUp(): void;
}

const sections = (root: HTMLElement, chips: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(".pd-reports, .pd-top > *, .pd-col > *, .pd-bottom > *"), ...chips.querySelectorAll<HTMLElement>(".pd-qa")]
    .filter((el) => canAnimate(el) && el.offsetHeight > 0);

/** Staggers the dashboard's sections in. Content is already laid out and
 *  visible underneath, so a failed animation leaves a normal dashboard.
 *
 *  A section can be rebuilt while the wave runs: a late load (Usage's token
 *  history) changes a card's height, the columns rebalance, and lit renders
 *  the card that switched column as a brand-new node with no animation, so it
 *  would sit there at full opacity ahead of everything still fading in.
 *  `catchUp`, run after every paint, gives such a node the fade it missed,
 *  timed to the slot it now holds in the wave. */
export function playEntrance(root: HTMLElement, chips: HTMLElement, now: () => number = () => performance.now()): Entrance {
  const started = now();
  const reduced = reducedMotion();
  const played = new WeakSet<HTMLElement>();
  const play = (el: HTMLElement, delay: number): void => {
    played.add(el);
    el.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: `translateY(${RISE_PX}px)` }, { opacity: 1, transform: "none" }],
      {
        duration: reduced ? REDUCED_MS : ENTER_MS,
        delay: reduced ? 0 : delay,
        easing: EASE_OUT,
        // Hidden through its own delay, not just once it starts.
        fill: "backwards",
      },
    );
  };
  const slot = (i: number): number => Math.min(i * STEP_MS, MAX_DELAY_MS);
  entranceOrder(sections(root, chips)).forEach((el, i) => play(el, slot(i)));
  return {
    catchUp(): void {
      const elapsed = now() - started;
      // Past the wave's last fade a new section is an ordinary live update.
      if (elapsed >= MAX_DELAY_MS + (reduced ? REDUCED_MS : ENTER_MS)) return;
      entranceOrder(sections(root, chips)).forEach((el, i) => {
        if (!played.has(el)) play(el, Math.max(0, slot(i) - elapsed));
      });
    },
  };
}

/** Copies where `live`'s still-running entrance has each section right now
 *  onto `copy`, a deep clone of it. A clone inherits none of the original's
 *  animations, so a section still waiting out its delay would otherwise show
 *  at full opacity in the copy and pop in just as the copy starts to fade. */
export function freezeEntrance(live: HTMLElement, copy: HTMLElement): void {
  const from = [live, ...live.querySelectorAll<HTMLElement>("*")];
  const to = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  from.forEach((el, i) => {
    const target = to[i];
    if (!target || !el.getAnimations?.().length) return;
    const cs = getComputedStyle(el);
    target.style.opacity = cs.opacity;
    target.style.transform = cs.transform;
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
