// Display helpers for an API-credit account's Console figures. A leaf module
// (type-only imports) so settings, the dashboard meter and the tests share one
// definition of how cents and reset dates read.

import type { ApiCreditStatus } from "../types/ipc.generated";

/** Whole dollars read bare ("$200"), anything else keeps its cents
 * ("$178.71"), so a limit and a balance on one line stay short. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = abs % 100;
  return `${sign}$${dollars}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}

/** "Nov 2". UTC on purpose: the Console's grant and spend cycle both roll over
 * at UTC midnight, so a viewer west of UTC would otherwise read the day before. */
export function formatResetDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** What a status line shows, split so each part can take its own styling. */
export interface ApiCreditLine {
  /** "$178.71 of $200 left, resets Nov 2 · $21.28 of $200 limit": the figures
   * alone, for a row that already names the account. Null when the Console
   * has returned no figure yet. */
  figures: string | null;
  /** `figures` led by "API credit ", for a row that names nothing else. */
  summary: string | null;
  /** Why the figures are missing or stale (Console not connected, session
   * expired, a failed fetch). */
  error: string | null;
  /** True when Connect Console is the fix for `error`. */
  needsConnect: boolean;
  /** The reason new turns are refused, when they are. */
  blockReason: string | null;
}

const CONNECT_ERROR = /not connected|expired/i;

export function apiCreditLine(status: ApiCreditStatus | null | undefined): ApiCreditLine {
  if (!status) return { figures: null, summary: null, error: null, needsConnect: false, blockReason: null };

  const parts: string[] = [];
  const remaining = status.max_grant_remaining_cents;
  if (remaining != null) {
    const total = status.max_grant_total_cents;
    const resets = formatResetDate(status.max_grant_expires_at);
    parts.push(`${formatCents(remaining)}${total != null ? ` of ${formatCents(total)}` : ""} left${resets ? `, resets ${resets}` : ""}`);
  }
  if (status.spend_cents != null && status.limit_cents != null) {
    parts.push(`${formatCents(status.spend_cents)} of ${formatCents(status.limit_cents)} limit`);
  }

  const figures = parts.length > 0 ? parts.join(" · ") : null;
  const error = status.error ? status.error : null;
  return {
    figures,
    summary: figures === null ? null : `API credit ${figures}`,
    error,
    needsConnect: error !== null && CONNECT_ERROR.test(error),
    blockReason: status.blocked ? (status.block_reason ?? "New turns on this account are paused.") : null,
  };
}

/** Share of the Max grant still unspent, 0..1, or null without both figures.
 * Drives the dashboard meter's fill. */
export function grantRemainingFraction(status: ApiCreditStatus | null | undefined): number | null {
  const remaining = status?.max_grant_remaining_cents;
  const total = status?.max_grant_total_cents;
  if (remaining == null || total == null || total <= 0) return null;
  return Math.min(1, Math.max(0, remaining / total));
}
