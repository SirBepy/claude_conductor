/**
 * Time parsing + relative formatting.
 * Ported from src/modules/formatters.js (hourToMs) and src/modules/stats.js (timeAgo).
 */

export function hourToMs(h: string): number {
  const [date = "", time = ""] = h.split("T");
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const parts = time.split(":");
  const hr = Number(parts[0] ?? 0);
  const min = parts[1] ? Number(parts[1]) : 0;
  return new Date(y, m - 1, d, hr, min).getTime();
}

export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const now = Date.now();
  let then: number;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}(:\d{2})?$/.test(dateStr)) {
    then = hourToMs(dateStr);
  } else {
    then = new Date(dateStr).getTime();
  }
  if (isNaN(then)) return "—";
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/** m:ss, or h:mm:ss once the span passes the hour. Negative input clamps to
 *  0:00 so a clock that reads slightly ahead of its start never shows a minus. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
