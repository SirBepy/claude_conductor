// Pure formatting/label helpers for the Schedule calendar view, split out of
// schedule.ts (ai_todo 721) so the render and mount modules share one source
// of truth for badges, labels and status text instead of duplicating them.

import { escapeHtml } from "../../shared/escape-html";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import type { ScheduledItem, Recurrence } from "../../types/ipc.generated";
import { pad, dayKeyOf, type DotStatus, type Occurrence } from "./schedule-recurrence";
import { state } from "./schedule-state";

export function todayKey(): string {
  return dayKeyOf(new Date());
}

export function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DOW_HEAD = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function recurrenceBadge(rec: Recurrence | null): string {
  if (!rec) return "";
  let label = "";
  switch (rec.rule.type) {
    case "daily": label = "daily"; break;
    case "weekly": label = `weekly ${rec.rule.weekdays.map((w) => WEEKDAY_LABELS[w] ?? "?").join(" ")}`; break;
    case "every_n_days": label = `every ${rec.rule.n}d`; break;
  }
  return label
    ? `<span class="schedule-badge schedule-badge--recurrence"><i class="ph ph-repeat"></i>${escapeHtml(label)}</span>`
    : "";
}

export function kindIconClass(item: ScheduledItem): string {
  if (item.kind.type === "new_chat") return "ph-plus-circle";
  if (item.kind.type === "jarvis_hygiene") return "ph-broom";
  return "ph-paper-plane-tilt";
}

export function targetLabel(item: ScheduledItem): string {
  if (item.kind.type === "new_chat") {
    return `New chat: ${cwdToProjectName(item.kind.cwd)}`;
  }
  if (item.kind.type === "jarvis_hygiene") {
    return "Jarvis: memory hygiene";
  }
  const title = state.titles.get(item.kind.session_id);
  if (title) return title;
  return truncate(item.prompt, 60);
}

/** Resolve the session id (and live/history mode) an item's chat opens as, or
 * null when there's nothing to open yet (an un-fired New chat has no session). */
export function navTarget(item: ScheduledItem): { sessionId: string; mode: string } | null {
  let sessionId: string | null = null;
  if (item.kind.type === "message") sessionId = item.kind.session_id;
  else sessionId = item.last_session_id ?? null; // new_chat: set once it fires
  if (!sessionId) return null;
  const mode = state.titles.has(sessionId) ? "live" : "history";
  return { sessionId, mode };
}

export function statusPill(status: DotStatus): string {
  const map: Record<DotStatus, [string, string]> = {
    upcoming: ["pending", "Upcoming"],
    firing: ["firing", "Firing…"],
    sent: ["sent", "Sent"],
    failed: ["failed", "Failed"],
    missed: ["missed", "Missed"],
    external: ["external", "Task Scheduler"],
  };
  // A projected recurring upcoming keeps the "Upcoming" label; a concrete
  // pending item is also "Upcoming" here (calendar doesn't split the two).
  const [cls, label] = map[status];
  return `<span class="schedule-status-pill schedule-status-pill--${cls}">${label}</span>`;
}

export function datetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const base = isNaN(d.getTime()) ? new Date() : d;
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;
}

export function dotClass(occ: Occurrence): string {
  if (occ.recurring && (occ.status === "upcoming" || occ.status === "firing")) return "dot dot--recurring";
  return `dot dot--${occ.status}`;
}
