// Pure data mapping for the floating multi-account overlay (milestone 06).
// DOM/api-free (only type-only-shaped inputs) so the account -> row mapping
// is unit-testable — see tests/overlay-logic.test.mjs. Mirrors the
// account-selector-logic.ts split: this module computes WHAT each row shows
// (percentages, safe-pace, reset), account-selector.ts/overlay.ts handle the
// HTML for their own (differently-shaped) markup.

import { computeSafePacePct } from "../../shared/formatters";
import type { AccountLite } from "../../shared/account-chip";

const SESSION_WINDOW_MS = 5 * 3_600_000;
const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;

export type OverlayAccountLite = AccountLite;

export interface OverlayUsageLite {
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
}

export interface OverlayMetric {
  pct: number | null;
  safePct: number | null;
  resetIso: string | null;
}

export interface OverlayRow {
  id: string;
  label: string;
  colour: string;
  icon: string;
  hasData: boolean;
  session: OverlayMetric;
  weekly: OverlayMetric;
}

/** One row's worth of data for an account, given its usage record (absent
 * when the account hasn't been polled yet this run — `hasData: false`, all
 * metrics null, matching how account-selector.ts treats a missing entry). */
export function buildOverlayRow(
  account: OverlayAccountLite,
  usage: OverlayUsageLite | undefined,
  now: number = Date.now(),
): OverlayRow {
  if (!usage) {
    return {
      id: account.id,
      label: account.label,
      colour: account.colour,
      icon: account.icon,
      hasData: false,
      session: { pct: null, safePct: null, resetIso: null },
      weekly: { pct: null, safePct: null, resetIso: null },
    };
  }
  const sessionSafe = computeSafePacePct(usage.session_resets_at, SESSION_WINDOW_MS, now);
  const weeklyFallback = usage.weekly_resets_at || new Date(now + 3_600_000).toISOString();
  const weeklySafe = computeSafePacePct(weeklyFallback, WEEKLY_WINDOW_MS, now);
  return {
    id: account.id,
    label: account.label,
    colour: account.colour,
    icon: account.icon,
    hasData: true,
    // resetIso carries the RAW reset timestamp (not weeklyFallback, which only
    // exists to anchor the safe-pace % calc above) - null when the account
    // genuinely has no active weekly reset yet, so the reset popup can skip
    // showing a fabricated countdown for it.
    session: { pct: usage.session_pct, safePct: sessionSafe, resetIso: usage.session_resets_at },
    weekly: { pct: usage.weekly_pct, safePct: weeklySafe, resetIso: usage.weekly_resets_at },
  };
}

/** Maps every registered account (in registry order) to its overlay row. */
export function buildOverlayRows(
  accounts: readonly OverlayAccountLite[],
  usageByAccount: Record<string, OverlayUsageLite>,
  now: number = Date.now(),
): OverlayRow[] {
  return accounts.map((a) => buildOverlayRow(a, usageByAccount[a.id], now));
}
