import { type ChipType, MAX_ROWS } from "../../../sessions/statusline-catalog";

// Pure operations on a ChipType[][] layout model. The DOM/pointer wiring (the
// builder view) calls these and re-renders from the returned array - never
// mutating DOM positions imperatively. Keeping the fragile reorder/remove logic
// pure makes it fully unit-testable.

export interface Pos { row: number; index: number; }

const clone = (rows: ChipType[][]): ChipType[][] => rows.map((r) => [...r]);

export function insertChip(rows: ChipType[][], at: Pos, chip: ChipType): ChipType[][] {
  const next = clone(rows);
  const row = next[at.row] ?? (next[at.row] = []);
  row.splice(Math.max(0, Math.min(at.index, row.length)), 0, chip);
  return next;
}

export function removeAt(rows: ChipType[][], at: Pos): ChipType[][] {
  const next = clone(rows);
  next[at.row]?.splice(at.index, 1);
  return next;
}

export function moveChip(rows: ChipType[][], from: Pos, to: Pos): ChipType[][] {
  const chip = rows[from.row]?.[from.index];
  if (chip === undefined) return clone(rows);
  const removed = removeAt(rows, from);
  // Adjust target index if removing earlier in the same row shifted it left.
  const adj = (from.row === to.row && from.index < to.index) ? { ...to, index: to.index - 1 } : to;
  return insertChip(removed, adj, chip);
}

/** `max` is the active profile's cap, not the global one - mobile allows fewer. */
export function addRow(rows: ChipType[][], max: number = MAX_ROWS): ChipType[][] {
  if (rows.length >= max) return clone(rows);
  return [...clone(rows), []];
}

/** Drop empty rows; always keep at least one (possibly-empty) row so the
 *  builder always has a drop target. */
export function trimRows(rows: ChipType[][]): ChipType[][] {
  const kept = rows.filter((r) => r.length > 0);
  return kept.length ? kept : [[]];
}

/** Move an entire row from `fromIdx` to `toIdx` (both 0-based). No-op if
 *  either index is out of range or they're equal. */
export function moveRow(rows: ChipType[][], fromIdx: number, toIdx: number): ChipType[][] {
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= rows.length || toIdx >= rows.length) {
    return clone(rows);
  }
  const next = clone(rows);
  const [row] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, row!);
  return next;
}
