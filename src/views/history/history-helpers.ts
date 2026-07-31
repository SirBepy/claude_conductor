import { escapeHtml } from "../../shared/escape-html";
import { projBadgeHtml } from "../sessions/sidebar-row-visuals";
import { characterForSessionId, characterIconUrl } from "../sessions/session-characters";
import type { HistoryEntry } from "../../types/ipc.generated";

export interface HistoryFilters {
  search: string;
  projectId: string | null;
  model: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export function emptyFilters(): HistoryFilters {
  return { search: "", projectId: null, model: null, dateFrom: null, dateTo: null };
}

/** Local midnight -> RFC3339, so a date filter is inclusive of the user's
 * whole calendar day rather than a UTC-shifted slice of it. */
export function startOfDayIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
export function endOfDayIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

export function hasActiveFilters(f: HistoryFilters): boolean {
  return !!(f.search || f.projectId || f.model || f.dateFrom || f.dateTo);
}

export function dateBucket(secs: number | bigint | null | undefined): string {
  if (!secs) return "Unknown date";
  const n = typeof secs === "bigint" ? Number(secs) : secs;
  if (!n) return "Unknown date";
  const d = new Date(n * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400_000);
  if (d >= startOfToday) return "Today";
  if (d >= startOfYesterday) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function formatTime(secs: number | bigint | null | undefined): string {
  if (secs === null || secs === undefined) return "";
  const n = typeof secs === "bigint" ? Number(secs) : secs;
  if (!n) return "";
  const d = new Date(n * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Historical equivalent of sessions-helpers' statusDotClass, mapping the
 * transcript's last `<cc-status:..>` marker onto the same st-* vocabulary.
 * "done" reads as the calm st-your-turn check, never the "unread" st-done
 * accent - a closed session has nothing left to notify about. */
export function historyStatusDotClass(status: string | null): string | null {
  switch (status) {
    case "question": return "st-question";
    case "working": return "st-working";
    case "waiting": return "st-waiting";
    case "done": return "st-your-turn";
    default: return null;
  }
}

/** Leading visual for a row: character portrait when one resolves for this
 * session id, else the plain project badge - never a status icon. A closed
 * session's last-turn status isn't a useful row-level signal, so no ring
 * tint either; mirrors draftLeadingVisual's charId-or-fallback shape in
 * sidebar-row-visuals.ts. */
export function historyLeadingVisual(e: HistoryEntry): string {
  const charId = characterForSessionId(e.session_id);
  if (!charId) return projBadgeHtml(e.cwd, "history-proj-icon");
  const id = escapeHtml(charId);
  const url = characterIconUrl(charId);
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  const avatarHtml = `<span class="session-avatar">
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  const badge = projBadgeHtml(e.cwd, "session-proj-badge");
  return `<span class="session-avatar-wrap">${avatarHtml}${badge}</span>`;
}
