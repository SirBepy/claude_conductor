// Pure data shaping for the Home skill charts (top skills, runs per day).
// No DOM or api imports so the bucketing is unit-testable (see
// tests/dashboard-skill-charts.test.mjs).

import type { SkillUsageEntry, SkillUsageEvent } from "../../../types/ipc.generated";

export const TOP_SKILLS = 5;
export const DAYS = 7;
/** How many skills' detail we fetch to build the per-day chart: the week
 * summary carries no timestamps, so each skill's events must be read one by
 * one. Capped so a long skill list is not N daemon round trips on every
 * Home paint; the chart says so when the cap cut something off. */
export const MAX_DETAIL_FETCHES = 12;

export interface SkillBar {
  skill: string;
  runs: number;
}

/** Skills ranked by invocation count over the week, ties broken by name so the
 * order does not flicker between refreshes. */
export function topSkills(entries: readonly SkillUsageEntry[], n: number = TOP_SKILLS): SkillBar[] {
  return entries
    .filter((e) => e.invocations.total > 0)
    .map((e) => ({ skill: e.skill, runs: e.invocations.total }))
    .sort((a, b) => b.runs - a.runs || a.skill.localeCompare(b.skill))
    .slice(0, n);
}

/** The skills worth fetching events for: the most-invoked first. */
export function skillsToFetch(entries: readonly SkillUsageEntry[]): { skills: string[]; truncated: boolean } {
  const ranked = topSkills(entries, Number.MAX_SAFE_INTEGER).map((b) => b.skill);
  return { skills: ranked.slice(0, MAX_DETAIL_FETCHES), truncated: ranked.length > MAX_DETAIL_FETCHES };
}

export interface DayBucket {
  /** yyyy-mm-dd, local. */
  key: string;
  /** Short weekday, e.g. "Mon". */
  label: string;
  runs: number;
}

function localKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One bucket per local day for the last `days` days ending today (oldest
 * first), counting every event on its local day. Events outside the window or
 * with an unparseable timestamp are dropped. */
export function runsPerDay(
  events: readonly Pick<SkillUsageEvent, "ts">[],
  now: Date,
  days: number = DAYS,
): DayBucket[] {
  const buckets: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    buckets.push({
      key: localKey(d),
      label: d.toLocaleDateString("en-GB", { weekday: "short" }),
      runs: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const ev of events) {
    const t = new Date(ev.ts);
    if (Number.isNaN(t.getTime())) continue;
    const b = byKey.get(localKey(t));
    if (b) b.runs += 1;
  }
  return buckets;
}
