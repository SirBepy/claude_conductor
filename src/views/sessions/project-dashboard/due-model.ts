// Pure rules for the Due card (no DOM, no IPC): when it shows, its day labels,
// which todos "Do all due" hands over, and the click-to-highlight toggle.
import type { DueId, DueSummary } from "./types";

/** The selection a click on the pill makes; a day's selection is its date. */
export const MISSED_SELECTION = "missed";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Missed todos plus every todo due in the five-day window. */
export function dueTotal(due: DueSummary): number {
  return due.missed_ids.length + due.days.reduce((n, d) => n + d.count, 0);
}

/** The card draws only when something is due soon or was missed. */
export function dueVisible(due: DueSummary): boolean {
  return dueTotal(due) > 0;
}

/** Todos to hand over: every missed one plus today's (the window's first day), each id once.
 *  Ids are device-prefixed and unique across repos, so the repo is no part of the identity. */
export function doAllIds(due: DueSummary): string[] {
  const today = due.days[0]?.ids ?? [];
  return [...new Set([...due.missed_ids, ...today].map((d) => d.id))];
}

/** The message that starts the one chat for "Do all due", or null when nothing is owed. */
export function doAllMessage(due: DueSummary): string | null {
  const ids = doAllIds(due);
  return ids.length ? `/auto-do-todos ${ids.join(",")}` : null;
}

/** "Today" for the first cell, else "Thu 12". Read from the date string alone,
 *  because `new Date("2026-11-12")` is UTC midnight and shifts a day west of it. */
export function dayLabel(date: string, index: number): string {
  if (index === 0) return "Today";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]!;
  return `${weekday} ${Number(m[3])}`;
}

/** Clicking the selected cell clears it; any other becomes the selection. */
export function toggleSelection(current: string | null, next: string): string | null {
  return current === next ? null : next;
}

/** The todos a selection stands for. */
export function selectionIds(due: DueSummary, selection: string | null): DueId[] {
  if (selection === null) return [];
  if (selection === MISSED_SELECTION) return due.missed_ids;
  return due.days.find((d) => d.date === selection)?.ids ?? [];
}
