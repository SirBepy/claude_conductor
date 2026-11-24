// Pure data mapping for the floating multi-account overlay (milestone 06).
// DOM/api-free (only type-only-shaped inputs) so the account -> row mapping
// is unit-testable — see tests/overlay-logic.test.mjs. Mirrors the
// account-selector-logic.ts split: this module computes WHAT each row shows
// (percentages, safe-pace, reset), account-selector.ts/overlay.ts handle the
// HTML for their own (differently-shaped) markup.

import { computeSafePacePct, pctInForce, windowPctOrNull, SESSION_WINDOW_MS, WEEKLY_WINDOW_MS } from "../../shared/formatters";
import { isApiCreditAccount, isEndpointAccount, isPlanAccount, type AccountLite } from "../../shared/account-chip";
import { apiCreditLine, grantRemainingFraction } from "../../shared/api-credit-format";
import { providerLine } from "../../shared/provider-usage-format";
import type { ApiCreditStatus, ProviderUsage } from "../../types/ipc.generated";

export type OverlayAccountLite = AccountLite;

export interface OverlayUsageLite {
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
  /** False when the plan has no 5h limit; undefined reads as limited. */
  session_limited?: boolean;
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
  /** False for a plan with no 5h limit: the dial draws only the weekly ring. */
  sessionLimited: boolean;
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
      sessionLimited: true,
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
    sessionLimited: usage.session_limited !== false,
    // resetIso carries the RAW reset timestamp (not weeklyFallback, which only
    // exists to anchor the safe-pace % calc above) - null when the account
    // genuinely has no active weekly reset yet, so the reset popup can skip
    // showing a fabricated countdown for it.
    // A window whose reset passed draws empty, like the Change account line's "Usage unknown",
    // until the poller brings the new figure.
    session: { pct: pctInForce(windowPctOrNull(usage.session_pct, usage.session_resets_at), usage.session_resets_at, now), safePct: sessionSafe, resetIso: usage.session_resets_at },
    weekly: { pct: pctInForce(usage.weekly_pct, usage.weekly_resets_at, now), safePct: weeklySafe, resetIso: usage.weekly_resets_at },
  };
}

/** Maps every plan account (in registry order) to its overlay row. An
 * API-credit account has no claude.ai usage, so it would draw an empty dial
 * here; the overlay window draws it through `buildOverlayEntries` instead, and
 * the phone header's dial row (usage-dials.ts) still skips it. */
export function buildOverlayRows(
  accounts: readonly OverlayAccountLite[],
  usageByAccount: Record<string, OverlayUsageLite>,
  now: number = Date.now(),
): OverlayRow[] {
  return accounts.filter(isPlanAccount).map((a) => buildOverlayRow(a, usageByAccount[a.id], now));
}

/** One API-credit account's dial: the share of the monthly Max grant still
 * unspent (null when the Console returned no figure, which the dial draws as an
 * unknown state, never as a full or empty ring) and the balance for the hover. */
export interface OverlayCreditRow {
  id: string;
  label: string;
  colour: string;
  icon: string;
  remaining: number | null;
  /** "$178.71", or null while the balance is unknown. */
  left: string | null;
}

export type OverlayEntry =
  | { kind: "plan"; row: OverlayRow }
  | { kind: "credit"; row: OverlayCreditRow }
  /** An Endpoint account whose provider reports a capped window (an OpenRouter key limit):
   * the same ring as a credit account, over what is left of the cap. */
  | { kind: "provider"; row: OverlayCreditRow };

/** The dial row of an Endpoint account, or null when its provider reports no
 * capped window: a bare balance has no fraction to draw, and an unknown figure
 * is not drawn as an empty or full ring, so neither gets a dial. */
export function buildOverlayProviderRow(account: OverlayAccountLite, usage: ProviderUsage | undefined): OverlayCreditRow | null {
  const line = providerLine(usage);
  if (line.pct === null) return null;
  return {
    id: account.id,
    label: account.label,
    colour: account.colour,
    icon: account.icon,
    remaining: Math.min(1, Math.max(0, 1 - line.pct / 100)),
    left: line.figures,
  };
}

export function buildOverlayCreditRow(account: OverlayAccountLite, status: ApiCreditStatus | undefined): OverlayCreditRow {
  const line = apiCreditLine(status);
  return {
    id: account.id,
    label: account.label,
    colour: account.colour,
    // The key glyph is how every other surface marks a credit account
    // (accountIconBadgeHtml), whatever icon the account carries.
    icon: "key",
    remaining: grantRemainingFraction(status),
    left: line.left,
  };
}

/** Every account in registry order, subscription and API-credit alike: the
 * floating overlay's dial row. */
export function buildOverlayEntries(
  accounts: readonly OverlayAccountLite[],
  usageByAccount: Record<string, OverlayUsageLite>,
  creditByAccount: Record<string, ApiCreditStatus>,
  now: number = Date.now(),
  providerByAccount: Partial<Record<string, ProviderUsage>> = {},
): OverlayEntry[] {
  // An Endpoint account has no claude.ai usage: it gets a dial only when its provider
  // reports a capped window.
  return accounts.flatMap((a): OverlayEntry[] => {
    if (isEndpointAccount(a)) {
      const row = buildOverlayProviderRow(a, providerByAccount[a.id]);
      return row ? [{ kind: "provider", row }] : [];
    }
    return [isApiCreditAccount(a)
      ? { kind: "credit", row: buildOverlayCreditRow(a, creditByAccount[a.id]) }
      : { kind: "plan", row: buildOverlayRow(a, usageByAccount[a.id], now) }];
  });
}
