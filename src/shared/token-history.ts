/**
 * Windowed loader for the token-history store. `token_records` holds one row
 * per session ever run, so an unbounded fetch grows forever - 100MB here.
 */

import { api } from "./api";
import { getTokenHistory, setTokenHistory } from "./state";
import type { TokenRecord } from "./tokens";

/** Covers the dashboard's 7d/30d ranges with headroom. */
export const DEFAULT_TOKEN_WINDOW_DAYS = 90;

/** Unix SECONDS floor. The store filters on `recordedAt`, always at or after
 *  `date`, so this stays a superset of the same window on `date`. */
export function windowSince(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86_400;
}

/** Widest window loaded so far; a narrower later request can't shrink it. */
let loadedSince: number | null = null;

/** Fetch the last `days` into state with live sessions appended; 0 = all. */
export async function loadTokenHistory(
  days: number = DEFAULT_TOKEN_WINDOW_DAYS,
): Promise<TokenRecord[]> {
  const since = days > 0 ? windowSince(days) : 0;
  const cached = getTokenHistory();
  if (cached && loadedSince !== null && since >= loadedSince) return cached;

  const history = (await api.getTokenHistory(since).catch(() => [])) ?? [];
  let active: TokenRecord[] = [];
  try {
    active = (await api.getActiveSessions()) ?? [];
  } catch {
    // Handler may not be registered yet; persisted rows still render.
  }
  const merged = mergeLiveSessions(history, active);
  loadedSince = since;
  setTokenHistory(merged);
  return merged;
}

/** Re-merges a pushed payload with live sessions, for `token-history-updated`. */
export function mergeLiveSessions(
  history: TokenRecord[] | null,
  active: TokenRecord[],
): TokenRecord[] {
  return active.length ? [...(history || []), ...active] : history || [];
}

/** Test seam: forget the loaded window so a fresh fetch is forced. */
export function resetTokenHistoryWindow(): void {
  loadedSince = null;
}
