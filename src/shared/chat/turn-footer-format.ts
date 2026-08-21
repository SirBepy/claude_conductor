/**
 * Formatting primitives for the turn footer's meta row, split off
 * turn-chips.ts (todo 729). Pure functions, no DOM, no footer state.
 */

/** Format elapsed milliseconds as "14s", "1m 20s", "1h 5m". */
export function formatTurnDuration(ms: number): string {
  const totalSecs = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Compact token count: "980", "2.1k", "12.4k". Pass `{ decimals: 0 }` for the
 * decimal-free form used by the context chip, e.g. "90k" / "200k".
 */
export function formatTokenCount(n: number, opts?: { decimals?: number }): string {
  const decimals = opts?.decimals ?? 1;
  const v = Number(n) || 0;
  if (v >= 1_000) {
    const k = v / 1000;
    return `${decimals <= 0 ? Math.round(k) : k.toFixed(decimals)}k`;
  }
  return String(Math.round(v));
}

/** Estimate output tokens from streamed assistant text length (chars / 4). */
export function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.round(text.length / 4));
}
