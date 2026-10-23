// Two-column placement for the dividers look's half-width sections (Projects
// dashboard and main Dashboard). Each section goes to whichever column is
// shorter so far, by its measured height, so the columns end near each other;
// CSS (pd-dashboard.css, dashboard.css) then spreads what is left of the gap
// across the shorter column's sections instead of leaving it under one of them.

/** Splits a reading-order list into full-width items and runs of adjacent
 *  half-width ones. A half-width item with no half-width neighbour has nothing
 *  to sit beside, so it stays full width instead of leaving an empty column. */
export function halfRuns<T>(items: T[], isHalf: (item: T) => boolean): Array<T | T[]> {
  const out: Array<T | T[]> = [];
  let run: T[] = [];
  const flush = (): void => {
    if (run.length === 1) out.push(run[0]!);
    else if (run.length > 1) out.push(run);
    run = [];
  };
  for (const item of items) {
    if (isHalf(item)) run.push(item);
    else { flush(); out.push(item); }
  }
  flush();
  return out;
}

/** The height a section needs, ignoring any stretch its column gave it. */
export function naturalHeight(sec: HTMLElement): number {
  const box = sec.getBoundingClientRect();
  const last = sec.lastElementChild as HTMLElement | null;
  if (!last) return box.height;
  const cs = getComputedStyle(sec);
  const lastBottom = last.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(last).marginBottom) || 0);
  return lastBottom - box.top + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
}

/** Greedy shortest-column placement, in reading order. Ties go left. */
export function assignColumns(heights: number[]): Array<0 | 1> {
  const total: [number, number] = [0, 0];
  return heights.map((h) => {
    const col: 0 | 1 = total[0] <= total[1] ? 0 : 1;
    total[col] += h;
    return col;
  });
}
