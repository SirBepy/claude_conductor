// Pure row-picking for the Home schedule widget. Kept free of DOM and api
// imports so the ordering and labelling rules are unit-testable (see
// tests/dashboard-schedule-widget.test.mjs).

import type { ExternalScheduledJob, ScheduledItem } from "../../../types/ipc.generated";
import { cwdToProjectName } from "../../sessions/sessions-helpers";
import { dateFromHumanTime } from "../../schedule/schedule-recurrence";

export interface UpcomingRow {
  /** Scheduled item id, or the external job id. */
  id: string;
  whenMs: number;
  label: string;
  /** Phosphor icon class for the row's kind. */
  icon: string;
  recurring: boolean;
  firing: boolean;
  /** True for an OS Task-Scheduler job the app only lists. */
  external: boolean;
}

export const UPCOMING_LIMIT = 4;

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}...` : t;
}

function itemLabel(item: ScheduledItem, titles: ReadonlyMap<string, string>): string {
  if (item.kind.type === "new_chat") return `New chat: ${cwdToProjectName(item.kind.cwd)}`;
  if (item.kind.type === "jarvis_hygiene") return "Jarvis: memory hygiene";
  return titles.get(item.kind.session_id) || truncate(item.prompt, 60);
}

function itemIcon(item: ScheduledItem): string {
  if (item.kind.type === "new_chat") return "ph-plus-circle";
  if (item.kind.type === "jarvis_hygiene") return "ph-broom";
  return "ph-paper-plane-tilt";
}

/** The next `limit` things that will fire, soonest first. A pending item's
 * `fire_at` is already its next fire (a recurring one advances after each
 * run), so no recurrence expansion is needed for "what is next". An overdue
 * pending item is kept: it is about to fire or be marked missed, which the
 * user still wants to see. Sent/failed/missed/skipped items are history. */
export function upcomingRows(
  items: readonly ScheduledItem[],
  external: readonly ExternalScheduledJob[],
  titles: ReadonlyMap<string, string>,
  limit: number = UPCOMING_LIMIT,
): UpcomingRow[] {
  const rows: UpcomingRow[] = [];
  for (const item of items) {
    const st = item.status.type;
    if (st !== "pending" && st !== "firing") continue;
    const whenMs = new Date(item.fire_at).getTime();
    if (Number.isNaN(whenMs)) continue;
    rows.push({
      id: item.id,
      whenMs,
      label: itemLabel(item, titles),
      icon: itemIcon(item),
      recurring: !!item.recurrence,
      firing: st === "firing",
      external: false,
    });
  }
  for (const job of external) {
    const d = job.fire_at ? dateFromHumanTime(job.fire_at) : null;
    if (!d) continue;
    rows.push({
      id: job.id,
      whenMs: d.getTime(),
      label: job.label,
      icon: "ph-clock-clockwise",
      recurring: false,
      firing: false,
      external: true,
    });
  }
  rows.sort((a, b) => a.whenMs - b.whenMs);
  return rows.slice(0, limit);
}

/** Short "when" text: a time today, "Tomorrow 09:00", or "Mon 3 Nov 09:00".
 * Local time, 24h, matching the calendar's own rows. */
export function whenLabel(whenMs: number, now: Date): string {
  const d = new Date(whenMs);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  if (dayDiff <= 0) return hhmm;
  if (dayDiff === 1) return `Tomorrow ${hhmm}`;
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${day} ${hhmm}`;
}
