// The dashboard's API-credit meter: one card per API-credit account,
// under the plan-usage cards it sits beside. Pure HTML so the figures can be
// repainted in place when a status event lands (no widget remount, see
// dashboard.ts). Text rules live in shared/api-credit-format.ts; the balance is
// the same dial the plan accounts draw (shared/usage-dial.ts).

import type { Account } from "../../shared/api";
import { escapeHtml } from "../../shared/escape-html";
import { apiCreditLinkedName, linkedPlanAccount } from "../../shared/account-chip";
import { getSettings } from "../../shared/state";
import { creditDialHtml } from "../../shared/usage-dial";
import "../overlay/overlay.css";
import { apiCreditLine, grantRemainingFraction } from "../../shared/api-credit-format";
import type { ApiCreditStatusMap } from "../../shared/api-credit-watch";

/** Dial size on the card: a little over the Settings row's, since this card is
 * the balance's main home. */
const DIAL_SCALE = 0.85;

function lineHtml(account: Account, statuses: ApiCreditStatusMap, all: readonly Account[]): string {
  const status = statuses[account.id];
  const line = apiCreditLine(status);
  const fraction = grantRemainingFraction(status);

  // A stale figure plus an error shows both, the error last, so the age of
  // the number is clear.
  const error = line.error
    ? `<button type="button" class="dash-credit-link" title="Go to Settings > Accounts">${escapeHtml(line.error)}${line.needsConnect ? " - Connect Console" : ""}</button>`
    : "";
  const warn = line.blockReason
    ? `<span class="dash-credit-warn"><i class="ph ph-warning"></i> ${escapeHtml(line.blockReason)}</span>`
    : "";
  const dial = `<span class="dash-credit-dial" role="img" aria-label="${fraction === null ? "Monthly API credit unknown" : `${Math.round(fraction * 100)}% of the monthly API credit left`}">${creditDialHtml(fraction, { icon: "key", colour: account.colour }, getSettings(), false, DIAL_SCALE)}</span>`;

  // The big figure is the balance; what the grant came to and when it lapses
  // sit under the bar, the Console spend against its limit opposite.
  const big = line.left
    ? `<span class="dash-credit-left"><b>${escapeHtml(line.left)}</b> left</span>`
    : line.error || line.spend ? "" : `<span class="dash-credit-text">No figures yet</span>`;
  const grant = [line.total ? `of ${line.total}` : "", line.expires ? `expires ${line.expires}` : ""].filter(Boolean).join(" · ");
  const meta = grant || line.spend
    ? `<div class="dash-credit-meta">
      <span>${escapeHtml(grant)}</span>
      ${line.spend ? `<span title="This month's Console spend against its spend limit">Spent ${escapeHtml(line.spend)}</span>` : ""}
    </div>`
    : "";
  const notes = error || warn ? `<div class="dash-credit-notes">${error}${warn}</div>` : "";

  return `<div class="dash-credit" data-acc-id="${escapeHtml(account.id)}" style="--acc:${escapeHtml(account.colour)}">
    <div class="dash-credit-head">
      ${dial}
      <span class="dash-credit-name">${escapeHtml(linkedPlanAccount(account, all) ? apiCreditLinkedName(account, all) : account.label)}</span>
      ${big}
    </div>
    ${meta}
    ${notes}
  </div>`;
}

/** Empty string when there is no API-credit account, so a subscription-only
 * dashboard gains no markup. */
export function apiCreditMeterHtml(accounts: readonly Account[], statuses: ApiCreditStatusMap): string {
  const credit = accounts.filter((a) => a.kind === "api_credit");
  if (credit.length === 0) return "";
  return `<div class="dash-credits">${credit.map((a) => lineHtml(a, statuses, accounts)).join("")}</div>`;
}
