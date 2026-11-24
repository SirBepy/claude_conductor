// The Done card's rules (docs/architecture/chat-dashboard.md, "Done card"): which finished features
// it holds, which show inline and which wait in the popup, and the release each popup row belongs
// under. Pure, so it tests on plain arrays; the rows are the Plan card's own `FeatureRow`s
// (features-model.ts `buildDoneFeatures`), so a feature keeps its line when it moves from Plan to Done.

import type { FeatureRow } from "./features-model";

/** Finished features drawn in the card itself before the rest go to the popup. */
export const DONE_INLINE = 3;
/** The popup holds the last day of finished features, and never fewer than this many. */
export const DONE_MIN = 10;
export const DONE_WINDOW_MS = 24 * 3_600_000;

/** What a divider in the popup is called when no release owns its features. */
export const UNRELEASED = "unreleased";
export const EARLIER = "earlier";

/** A release the card can name: the What's new entries' version and ISO date. */
export interface ReleaseDate {
  version: string;
  /** `YYYY-MM-DD`, the day it shipped. */
  date: string;
}

/** The newest `DONE_INLINE` features of the card, then the rest of the window: the last 24 hours,
 *  or the newest `DONE_MIN` when fewer than that finished in a day. Input is newest first. */
export function doneWindow(rows: readonly FeatureRow[], now: number): { inline: FeatureRow[]; rest: FeatureRow[] } {
  const inDay = rows.filter((r) => (r.doneAt ?? 0) >= now - DONE_WINDOW_MS);
  const held = inDay.length >= DONE_MIN ? inDay : rows.slice(0, DONE_MIN);
  return { inline: held.slice(0, DONE_INLINE), rest: held.slice(DONE_INLINE) };
}

/** The release a finish time falls in, from the What's new entries: the first release whose day had
 *  not ended when the feature finished. A feature newer than every release is "unreleased"; with no
 *  dated release at all there is nothing to name ("earlier"). An approximation of "the release whose
 *  tag holds the merge": the daemon does not know a feature's merge commit, and a release with no
 *  What's new entry has no divider of its own, so its features fold into the next entry. */
export function releaseOf(doneAt: number | null, releases: readonly ReleaseDate[]): string {
  if (doneAt === null) return EARLIER;
  const dated = releases.map((r) => ({ version: r.version, end: Date.parse(`${r.date}T23:59:59.999`) })).filter((r) => !Number.isNaN(r.end));
  if (dated.length === 0) return EARLIER;
  // Two releases on one day tie on `end`; the older version takes the day's finishes, as the doc above says "first".
  dated.sort((a, b) => a.end - b.end || a.version.localeCompare(b.version, undefined, { numeric: true }));
  return dated.find((r) => r.end >= doneAt)?.version ?? UNRELEASED;
}

export interface DoneGroup {
  /** A version without its "v", `UNRELEASED` or `EARLIER`. */
  release: string;
  rows: FeatureRow[];
}

/** The popup's rows in order, a new group wherever the release changes. */
export function groupByRelease(rows: readonly FeatureRow[], releases: readonly ReleaseDate[]): DoneGroup[] {
  const groups: DoneGroup[] = [];
  for (const row of rows) {
    const release = releaseOf(row.doneAt, releases);
    const last = groups[groups.length - 1];
    if (last && last.release === release) last.rows.push(row);
    else groups.push({ release, rows: [row] });
  }
  return groups;
}

/** A row matches the popup's search when its title, todo id or ticket id holds the words. */
export function doneMatches(row: FeatureRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.title.toLowerCase().includes(q) || (row.todoId ?? "").toLowerCase().includes(q) || (row.ticket?.id ?? "").toLowerCase().includes(q);
}
