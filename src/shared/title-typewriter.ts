/**
 * Typewriter swap for a chat's title: backspaces the old text down to what the
 * old and new titles share, then types the rest. One element, one run - a newer
 * swap on the same element cancels the older one and picks up from whatever is
 * on screen, so a title that changes twice in a row never stutters or jumps.
 *
 * The title shows in the pane header and in the sidebar row; both call this so
 * "New chat" -> the name Claude picks reads the same everywhere.
 */

/** Per-character pace, with a ceiling on the whole phase so a 200-character
 *  title does not take ten seconds to type. */
const ERASE_MS_PER_CHAR = 14;
const ERASE_MAX_MS = 350;
const TYPE_MS_PER_CHAR = 30;
const TYPE_MAX_MS = 1100;

/** Keeps the element one line tall while it is empty mid-swap. Without it an
 *  `overflow: hidden` title collapses to zero height and the header jumps. */
const EMPTY_HOLD = "​";

interface Run {
  /** The title this element is heading to. */
  target: string;
  /** What is on screen right now. */
  shown: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const runs = new WeakMap<HTMLElement, Run>();

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function paint(el: HTMLElement, text: string): void {
  el.textContent = text || EMPTY_HOLD;
}

/** The title the element is showing or heading to, ignoring a swap in flight. */
export function titleTarget(el: HTMLElement): string {
  return runs.get(el)?.target ?? (el.textContent ?? "").replace(EMPTY_HOLD, "");
}

/** What the element shows this instant (a half-typed title mid-swap). */
export function titleShown(el: HTMLElement): string {
  return runs.get(el)?.shown ?? (el.textContent ?? "").replace(EMPTY_HOLD, "");
}

/** Stops a swap in flight and leaves whatever is on screen. For an element the
 *  caller is about to detach, so its timer does not keep painting a dead node. */
export function cancelTitleSwap(el: HTMLElement): void {
  const run = runs.get(el);
  if (run?.timer) clearTimeout(run.timer);
  runs.delete(el);
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Animates `el` to `next`. `from` is the text the element should be treated as
 * showing - pass it when `el` was just rebuilt and holds the final text already
 * (the sidebar re-renders a row's markup wholesale). Without it the element's
 * own current text is the start.
 *
 * `animate: false`, reduced motion, or a start of "" (nothing to erase, e.g. a
 * freshly mounted header) sets the text outright.
 */
export function typeSwap(el: HTMLElement, next: string, opts: { from?: string; animate?: boolean } = {}): void {
  const prev = runs.get(el);
  // The pane header calls this on every instances-changed with the title it
  // already has; a burst of those must not re-arm the timer and stall the swap.
  if (prev && prev.target === next && opts.from === undefined && opts.animate !== false) return;
  if (prev?.timer) clearTimeout(prev.timer);
  const start = opts.from ?? prev?.shown ?? titleShown(el);

  // instances-changed fires constantly; an unchanged title must not rewrite the DOM.
  if (start === next && !prev && opts.from === undefined) return;

  if (start === next || opts.animate === false || reducedMotion() || (start === "" && !prev)) {
    runs.delete(el);
    paint(el, next);
    return;
  }

  const run: Run = { target: next, shown: start, timer: null };
  runs.set(el, run);
  paint(el, start);

  const keep = commonPrefixLength(start, next);
  const eraseStep = Math.min(ERASE_MS_PER_CHAR, ERASE_MAX_MS / Math.max(1, start.length - keep));
  const typeStep = Math.min(TYPE_MS_PER_CHAR, TYPE_MAX_MS / Math.max(1, next.length - keep));

  let erasing = run.shown.length > keep;
  const step = (): void => {
    if (erasing && run.shown.length <= keep) erasing = false;
    if (erasing) {
      run.shown = run.shown.slice(0, -1);
      paint(el, run.shown);
      run.timer = setTimeout(step, eraseStep);
      return;
    }
    if (run.shown.length < next.length) {
      run.shown = next.slice(0, run.shown.length + 1);
      paint(el, run.shown);
      run.timer = setTimeout(step, typeStep);
      return;
    }
    runs.delete(el);
  };
  run.timer = setTimeout(step, eraseStep);
}
