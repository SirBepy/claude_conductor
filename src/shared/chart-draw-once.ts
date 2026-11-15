// One rule for the line charts' draw-in (`.chart-line-draw`, styles/chart.css): a
// chart plays it the first time it is on screen and never again. The CSS
// animation restarts on any new node, and a repaint rebuilds an SVG from a
// string, so without this every live event, chat click and remount replayed it.

// A repaint inside the draw-in's own run keeps the class (the lines start over
// in the new node, as before); past it the chart is repainted still.
export const DRAW_WINDOW_MS = 1500;
const firstDrawn = new Map<string, number>();

/** Whether a chart named `key` should play its draw-in now. Pure given `now`,
 *  for tests. A chart with no key draws on every render. */
export function drawsIn(key: string | undefined, now: number = Date.now()): boolean {
  if (!key) return true;
  const at = firstDrawn.get(key);
  if (at === undefined) { firstDrawn.set(key, now); return true; }
  return now - at < DRAW_WINDOW_MS;
}
