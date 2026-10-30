// Pure date + recurrence math for the Schedule calendar view (ai_todo 234).
// Split out of schedule.ts so that file holds only rendering + mount/action
// wiring. `nextOccurrence`/`expandRecurrence` are a TS port of the Rust
// `next_occurrence` in src-tauri/src/sessions/scheduled_items.rs.

import type {
  ScheduledItem,
  ExternalScheduledJob,
  Recurrence,
} from "../../types/ipc.generated";

export type DotStatus = "upcoming" | "firing" | "sent" | "failed" | "missed" | "skipped" | "external";

/** One placement of an item on a specific calendar day. */
export interface Occurrence {
  /** yyyy-mm-dd local key for the day this lands on. */
  dayKey: string;
  /** epoch millis of the exact local instant (for sorting within a day). */
  time: number;
  status: DotStatus;
  /** Underlying scheduled item, or null for an external Task-Scheduler job. */
  item: ScheduledItem | null;
  external?: ExternalScheduledJob;
  /** True when this occurrence is a projected future repeat (hollow ring). */
  recurring: boolean;
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** `schedule_list_external`'s `humanTime` is a local "yyyy-MM-dd HH:mm:ss"
 * string (not RFC3339) - reparse as a local wall-clock Date. */
export function dateFromHumanTime(humanTime: string): Date | null {
  const d = new Date(humanTime.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

// ── recurrence expansion (mirror of scheduled_items.rs next_occurrence) ───────

export function parseHhmm(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return [0, 0];
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return [0, 0];
  return [h, mi];
}

/** Next local occurrence strictly after `after`, per rule. Mirrors the Rust. */
export function nextOccurrence(after: Date, rec: Recurrence): Date {
  const [hour, minute] = parseHhmm(rec.time);
  const atTime = (base: Date): Date => new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);

  if (rec.rule.type === "daily") {
    const today = atTime(after);
    if (today > after) return today;
    const t = new Date(after);
    t.setDate(t.getDate() + 1);
    return atTime(t);
  }
  if (rec.rule.type === "weekly") {
    const weekdays = rec.rule.weekdays; // 0=Mon..6=Sun
    if (!weekdays.length) {
      const t = new Date(after);
      t.setDate(t.getDate() + 1);
      return atTime(t);
    }
    for (let offset = 0; offset <= 7; offset++) {
      const d = new Date(after);
      d.setDate(d.getDate() + offset);
      const dow = (d.getDay() + 6) % 7; // JS Sun=0 -> Mon=0
      if (!weekdays.includes(dow)) continue;
      const cand = atTime(d);
      if (cand > after) return cand;
    }
    const t = new Date(after);
    t.setDate(t.getDate() + 7);
    return atTime(t);
  }
  // every_n_days
  const n = Math.max(1, rec.rule.n);
  const today = atTime(after);
  if (today > after) return today;
  const t = new Date(after);
  t.setDate(t.getDate() + n);
  return atTime(t);
}

/** All occurrence instants of a recurring item within [start, end] (inclusive
 * day range), starting from its stored next fire_at. Capped to avoid runaway. */
export function expandRecurrence(fireAt: Date, rec: Recurrence, end: Date): Date[] {
  const out: Date[] = [];
  let cur = fireAt;
  let guard = 0;
  while (cur <= end && guard < 500) {
    out.push(new Date(cur));
    cur = nextOccurrence(cur, rec);
    guard++;
  }
  return out;
}

// ── build occurrences for the visible grid ───────────────────────────────────

/** The 6-week grid range (Mon-start) covering the visible month. */
export function gridRange(year: number, month: number): { start: Date; end: Date; cells: Date[] } {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0
  const start = new Date(year, month, 1 - lead);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  const last = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 41);
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59);
  return { start, end, cells };
}

export function isPastStatus(t: ScheduledItem["status"]["type"]): boolean {
  return t === "sent" || t === "failed" || t === "missed" || t === "skipped";
}

/** Places every item/external job onto the calendar days it occupies within
 * [.., rangeEnd], expanding recurring items onto each projected repeat. */
export function buildOccurrences(
  items: ScheduledItem[],
  external: ExternalScheduledJob[],
  rangeEnd: Date,
): Map<string, Occurrence[]> {
  const byDay = new Map<string, Occurrence[]>();
  const push = (occ: Occurrence) => {
    const arr = byDay.get(occ.dayKey);
    if (arr) arr.push(occ);
    else byDay.set(occ.dayKey, [occ]);
  };

  for (const item of items) {
    const st = item.status.type;
    if (isPastStatus(st)) {
      // Past: place on when it actually fired (fall back to fire_at). A
      // skipped one never fired, so its guard's run time is the moment.
      const when = new Date(st === "skipped" ? item.last_skip?.at || item.fire_at : item.last_fired_at || item.fire_at);
      if (isNaN(when.getTime())) continue;
      push({ dayKey: dayKeyOf(when), time: when.getTime(), status: st as DotStatus, item, recurring: false });
      continue;
    }
    // A recurring item goes back to Pending after its guard turns a firing
    // away, so the skip is the only trace of that firing - give it its own
    // past placement, or it would look like the run never happened.
    const skippedAt = item.last_skip ? new Date(item.last_skip.at) : null;
    if (skippedAt && !isNaN(skippedAt.getTime())) {
      push({ dayKey: dayKeyOf(skippedAt), time: skippedAt.getTime(), status: "skipped", item, recurring: false });
    }
    // Pending / firing (upcoming).
    const base = new Date(item.fire_at);
    if (isNaN(base.getTime())) continue;
    const instants = item.recurrence
      ? expandRecurrence(base, item.recurrence, rangeEnd)
      : [base];
    for (const inst of instants) {
      const isBase = inst.getTime() === base.getTime();
      push({
        dayKey: dayKeyOf(inst),
        time: inst.getTime(),
        // Only the concrete next fire can be mid-"firing"; projected repeats are upcoming.
        status: st === "firing" && isBase ? "firing" : "upcoming",
        item,
        recurring: !!item.recurrence,
      });
    }
  }

  for (const job of external) {
    const d = job.fire_at ? dateFromHumanTime(job.fire_at) : null;
    if (!d) continue;
    push({ dayKey: dayKeyOf(d), time: d.getTime(), status: "external", item: null, external: job, recurring: false });
  }

  return byDay;
}
