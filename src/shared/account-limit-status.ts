// One-line status of a payment account for the Change account picker: how full
// its 5h and 7d windows are (subscription) or what is left of its monthly grant
// (API credit). Pure, so every branch is unit-testable. An unknown figure is
// always "unknown" (never 0, never at-limit): the daemon simply has none yet.

import type { ApiCreditStatus } from "../types/ipc.generated";
import { apiCreditLine } from "./api-credit-format";
import { pctInForce, resetUrgency, windowPctOrNull } from "./formatters";
import type { OverlayUsageLite } from "../views/overlay/overlay-logic";

export type LimitTone = "ok" | "limit" | "unknown";

export interface AccountLimitStatus {
  text: string;
  tone: LimitTone;
  /** Short flag a limited account shows at rest: "5h limit", "7d limit", or the
   * pause reason of an API-credit account. Set exactly when `tone` is "limit". */
  pill?: string;
  /** When the limit lifts, as resetUrgency words it ("in 53m"), if the reset time is known. */
  backIn?: string;
  /** The window figures behind `text` ("5h 42%", "7d 31%"), for a row that
   * draws them as separate runs. Only on a subscription whose windows are known. */
  figures?: string[];
}

function pctText(pct: number | null): string {
  return pct === null ? "--" : `${Math.round(pct)}%`;
}

/** "5h 42% · 7d 31%", or the window that is full with when it reopens. */
export function subscriptionLimitStatus(usage: OverlayUsageLite | undefined): AccountLimitStatus {
  if (!usage) return { text: "No usage data yet", tone: "unknown" };
  const limited = usage.session_limited !== false;
  // 0% with no reset time is no running window: unknown, not "0% used".
  // A figure whose window already reset reads as unknown, not as a limit that no longer stands.
  const session = limited ? pctInForce(windowPctOrNull(usage.session_pct, usage.session_resets_at), usage.session_resets_at) : null;
  const weekly = pctInForce(windowPctOrNull(usage.weekly_pct, usage.weekly_resets_at), usage.weekly_resets_at);
  if (weekly !== null && weekly >= 100) {
    const reset = resetUrgency(usage.weekly_resets_at);
    return { text: `7d limit reached${reset ? `, resets ${reset.text}` : ""}`, tone: "limit", pill: "7d limit", ...(reset ? { backIn: reset.text } : {}) };
  }
  if (session !== null && session >= 100) {
    const reset = resetUrgency(usage.session_resets_at);
    return { text: `5h limit reached${reset ? `, resets ${reset.text}` : ""}`, tone: "limit", pill: "5h limit", ...(reset ? { backIn: reset.text } : {}) };
  }
  if (weekly === null && session === null) return { text: "Usage unknown", tone: "unknown" };
  const parts = [limited ? `5h ${pctText(session)}` : null, `7d ${pctText(weekly)}`].filter((p): p is string => p !== null);
  return { text: parts.join(" · "), tone: "ok", figures: parts };
}

/** "$145.68 of $200 left", the pause reason when new turns are refused, or
 * "Balance unknown" while the Console has returned nothing usable. */
export function apiCreditLimitStatus(status: ApiCreditStatus | undefined): AccountLimitStatus {
  const line = apiCreditLine(status);
  if (line.blockReason) return { text: line.blockReason, tone: "limit", pill: line.blockReason };
  if (line.left !== null) return { text: `${line.left}${line.total ? ` of ${line.total}` : ""} left`, tone: "ok" };
  return { text: line.needsConnect ? "Connect Console to see the balance" : "Balance unknown", tone: "unknown" };
}
