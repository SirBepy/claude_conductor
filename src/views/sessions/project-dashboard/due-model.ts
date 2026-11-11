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

/** One spelling of a repo folder for comparing paths from the daemon with a repo ref's. */
export function normCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Todos to hand over: every missed one plus today's (the window's first day), once each.
 *  The identity is repo plus id: a group's repos number their todos independently, so two repos can both own "pc-1". */
export function doAllIds(due: DueSummary): DueId[] {
  const today = due.days[0]?.ids ?? [];
  const seen = new Set<string>();
  const out: DueId[] = [];
  for (const d of [...due.missed_ids, ...today]) {
    const key = `${normCwd(d.repo_cwd)}\n${d.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** The repos that own something "Do all due" hands over, each with how many, in first-seen order. */
export function doAllRepos(due: DueSummary): Array<{ cwd: string, count: number }> {
  const byRepo = new Map<string, { cwd: string, count: number }>();
  for (const d of doAllIds(due)) {
    const key = normCwd(d.repo_cwd);
    const row = byRepo.get(key);
    if (row) row.count++;
    else byRepo.set(key, { cwd: d.repo_cwd, count: 1 });
  }
  return [...byRepo.values()];
}

/** The message that starts the one chat for "Do all due", or null when nothing is owed.
 *  Given `repoCwd`, only that repo's ids go in, because the chat starts in one repo and cannot resolve another's. */
export function doAllMessage(due: DueSummary, repoCwd?: string): string | null {
  const want = repoCwd === undefined ? null : normCwd(repoCwd);
  const ids = doAllIds(due).filter((d) => want === null || normCwd(d.repo_cwd) === want).map((d) => d.id);
  return ids.length ? `/auto-do-todos ${ids.join(",")}` : null;
}

/** The selection that stays valid on a fresh snapshot: the missed pill while something is missed,
 *  a day while it is still in the window, else none. */
export function reconcileSelection(due: DueSummary, selection: string | null): string | null {
  if (selection === null) return null;
  if (selection === MISSED_SELECTION) return due.missed_ids.length ? selection : null;
  return due.days.some((d) => d.date === selection) ? selection : null;
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
