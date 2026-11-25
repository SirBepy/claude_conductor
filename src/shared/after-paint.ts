// Free of lit-html and CSS so any module (modal host, toast) can import it.

/** Longest wait for one frame before giving up on it. About four 60 Hz
 *  frames: long enough that a live window always paints first, short enough
 *  that the fallback reads as the same motion. */
const FRAME_FALLBACK_MS = 64;

/** Runs `fn` after `frames` animation frames (default 1), or after
 *  FRAME_FALLBACK_MS per frame if they do not come. WebView2 pauses
 *  requestAnimationFrame while its window counts as hidden or occluded
 *  (flush-scheduler.ts), and an enter animation that starts from a hidden
 *  class and drops it on a frame then never starts: the backdrop (plain CSS)
 *  shows, the card stays at opacity 0 (Joe 2026-11-25, Ctrl+N: a dimmed
 *  window and no picker). `fn` runs once, whichever fires first. `frames: 2`
 *  is for "the start state has to be painted once first". */
export function afterPaint(fn: () => void, frames = 1): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame === "function") {
    const step = (left: number) => requestAnimationFrame(() => (left <= 1 ? run() : step(left - 1)));
    step(frames);
  }
  setTimeout(run, FRAME_FALLBACK_MS * frames);
}

/** Promise form of afterPaint. */
export const nextPaint = (): Promise<void> => new Promise((r) => afterPaint(() => r()));
