// Free of lit-html and CSS so any module (modal host, toast) can import it.

/** Longest wait for a frame before giving up on it. About four 60 Hz frames:
 *  long enough that a live window always paints first, short enough that the
 *  fallback reads as the same motion. */
const FRAME_FALLBACK_MS = 64;

/** Runs `fn` on the next animation frame, or after FRAME_FALLBACK_MS if no
 *  frame comes. WebView2 pauses requestAnimationFrame while its window counts
 *  as hidden or occluded (flush-scheduler.ts), and an enter animation that
 *  starts from a hidden class and drops it on a frame then never starts: the
 *  backdrop (plain CSS) shows, the card stays at opacity 0 (Joe 2026-11-25,
 *  Ctrl+N: a dimmed window and no picker). `fn` runs once, whichever fires. */
export function afterPaint(fn: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  setTimeout(run, FRAME_FALLBACK_MS);
}

/** Promise form of afterPaint. */
export const nextPaint = (): Promise<void> => new Promise((r) => afterPaint(() => r()));
