// One-line status of a payment account for the Change account picker: how full
// its 5h and 7d windows are (subscription) or what is left of its monthly grant
// (API credit). Pure, so every branch is unit-testable. An unknown figure is
// always "unknown" (never 0, never at-limit): the daemon simply has none yet.

import type { ApiCreditStatus } from "../types/ipc.generated";
import { apiCreditLine } from "./api-credit-format";
import { resetUrgency, windowPctOrNull } from "./formatters";
import type { OverlayUsageLite } from "../views/overlay/overlay-logic";

export type LimitTone = "ok" | "limit" | "unknown";

export interface AccountLimitStatus {
  text: string;
  tone: LimitTone;
}

/** A figure whose window already reset is stale until the poller refreshes: it
 * reads as unknown rather than as a limit that is no longer in force. */
function livePct(pct: number | null, resetIso: string | null | undefined): number | null {
  if (pct === null) return null;
  const reset = resetIso ? Date.parse(resetIso) : NaN;
  return Number.isFinite(reset) && reset <= Date.now() ? null : pct;
}

function pctText(pct: number | null): string {
  return pct === null ? "--" : `${Math.round(pct)}%`;
}

/** "5h 42% · 7d 31%", or the window that is full with when it reopens. */
export function subscriptionLimitStatus(usage: OverlayUsageLite | undefined): AccountLimitStatus {
  if (!usage) return { text: "No usage data yet", tone: "unknown" };
  const limited = usage.session_limited !== false;
  // 0% with no reset time is no running window: unknown, not "0% used".
  const session = limited ? livePct(windowPctOrNull(usage.session_pct, usage.session_resets_at), usage.session_resets_at) : null;
  const weekly = livePct(usage.weekly_pct, usage.weekly_resets_at);
  if (weekly !== null && weekly >= 100) {
    const reset = resetUrgency(usage.weekly_resets_at);
    return { text: `7d limit reached${reset ? `, resets in ${reset.text}` : ""}`, tone: "limit" };
  }
  if (session !== null && session >= 100) {
    const reset = resetUrgency(usage.session_resets_at);
    return { text: `5h limit reached${reset ? `, resets in ${reset.text}` : ""}`, tone: "limit" };
  }
  if (weekly === null && session === null) return { text: "Usage unknown", tone: "unknown" };
  const parts = [limited ? `5h ${pctText(session)}` : null, `7d ${pctText(weekly)}`].filter((p): p is string => p !== null);
  return { text: parts.join(" · "), tone: "ok" };
}

/** "$145.68 of $200 left", the pause reason when new turns are refused, or
 * "Balance unknown" while the Console has returned nothing usable. */
export function apiCreditLimitStatus(status: ApiCreditStatus | undefined): AccountLimitStatus {
  const line = apiCreditLine(status);
  if (line.blockReason) return { text: line.blockReason, tone: "limit" };
  if (line.left !== null) return { text: `${line.left}${line.total ? ` of ${line.total}` : ""} left`, tone: "ok" };
  return { text: line.needsConnect ? "Connect Console to see the balance" : "Balance unknown", tone: "unknown" };
}
