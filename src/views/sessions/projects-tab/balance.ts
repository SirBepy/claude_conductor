// Two-column placement for the dashboard's half-width sections. Each section
// goes to whichever column is shorter so far, by its measured height, so the
// columns end near each other; CSS (pd-dashboard.css) then spreads what is
// left of the gap across the shorter column's sections instead of leaving it
// under one of them.

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
