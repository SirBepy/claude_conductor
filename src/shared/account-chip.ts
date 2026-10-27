// Shared account icon/colour rendering (multi-account milestone 04). One
// definition reused by Settings > Accounts, the project Automation "Claude
// account" row, its reverse "projects using this account" list, and the
// new-chat account picker - never a per-view visual copy.
// See docs/multi-account/04-project-binding.md.

import { escapeHtml } from "./escape-html";

export type AccountKindLite = "subscription" | "api_credit";

export interface AccountChipInfo {
  icon: string;
  colour: string;
  label: string;
  /** Absent means a subscription account (older daemons and peer machines
   * never send it). */
  kind?: AccountKindLite;
}

/** The 4-field "lite account" shape shared by the dashboard account-selector,
 * new-chat account picker, and overlay row mapping - each only needs id +
 * the display fields, not the full `Account` type from shared/api.ts. One
 * declaration here, imported everywhere, instead of three per-view copies. */
export interface AccountLite {
  id: string;
  label: string;
  icon: string;
  colour: string;
  kind?: AccountKindLite;
  /** Present on a full account and on a peer's lite one; links an API-credit
   * account to its plan account (see linkedPlanAccount). */
  email?: string;
}

/** An API-credit account bills the Max plan's monthly API credit, never the
 * subscription limits; every list that mixes the two kinds branches on this. */
export function isApiCreditAccount(a: { kind?: AccountKindLite } | null | undefined): boolean {
  return a?.kind === "api_credit";
}

/** The plan (subscription) account an API-credit account belongs to, or null.
 * The link is the email: the backend stamps an API-credit account with the
 * default subscription account's claude.ai login, so the two share it. It can
 * be empty (no login yet), and then nothing is linked. Case-insensitive
 * because emails are not case-sensitive in practice. */
export function linkedPlanAccount<T extends { kind?: AccountKindLite; email?: string }>(
  account: { email?: string } | null | undefined,
  accounts: readonly T[],
): T | null {
  const email = account?.email?.trim().toLowerCase();
  if (!email) return null;
  return accounts.find((a) => !isApiCreditAccount(a) && a.email?.trim().toLowerCase() === email) ?? null;
}

/** "Linked to personal": the Settings row's line for an API-credit account. A
 * login with no matching plan account shows the email itself; no email at all
 * gives "" so the row draws nothing. */
export function linkedToLabel(
  account: { email?: string },
  accounts: readonly { kind?: AccountKindLite; email?: string; label: string }[],
): string {
  const plan = linkedPlanAccount(account, accounts);
  if (plan) return `Linked to ${plan.label}`;
  const email = account.email?.trim();
  return email ? `Linked to ${email}` : "";
}

/** The label every API-credit account starts with; a chip carrying it says
 * nothing about which account it is, so the name leans on the plan instead. */
const DEFAULT_API_CREDIT_LABEL = "API credit";

/** "API credit · personal": how an API-credit account names itself where the
 * plan it draws on is worth showing. Just "API credit" when nothing is linked.
 * An account the user renamed leads with its own label ("Spare key · personal")
 * because several API-credit accounts can link to one plan, and the plan alone
 * would make them read identically. */
export function apiCreditLinkedName(
  account: { email?: string; label?: string } | null | undefined,
  accounts: readonly { kind?: AccountKindLite; email?: string; label: string }[],
): string {
  const plan = linkedPlanAccount(account, accounts);
  const own = account?.label?.trim();
  const lead = own && own !== DEFAULT_API_CREDIT_LABEL ? own : DEFAULT_API_CREDIT_LABEL;
  return plan ? `${lead} · ${plan.label}` : lead;
}

/** Coloured circular icon badge for an account. Pair with `.account-chip-css`
 * (imported by the caller) for the `.account-icon-badge` rule. */
export function accountIconBadgeHtml(a: AccountChipInfo): string {
  // The key marks the billing kind everywhere an account is drawn, whatever
  // icon the account row stores.
  const icon = isApiCreditAccount(a) ? "key" : a.icon;
  return `<span class="account-icon-badge" style="--acc:${escapeHtml(a.colour)}"><i class="ph ph-${escapeHtml(icon)}"></i></span>`;
}

/** Trailing "API credit" tag for an API-credit account's chip, so a pick that
 * bills the Max plan's monthly API credit instead of plan usage is never a
 * surprise. The key icon already comes from `accountIconBadgeHtml`. Styled by
 * `.cam-credit-hint` in change-account-modal.css. */
export function apiCreditHintHtml(a: { kind?: AccountKindLite }): string {
  return isApiCreditAccount(a) ? `<span class="cam-credit-hint">API credit</span>` : "";
}

/** Icon badge + label, inline (a "chip"), plus the API-credit tag for that
 * account kind. `selected` adds the `.sel` state
 * used by the new-chat picker's chip row. `extraAttrs` is a raw (already
 * escaped) attribute string, e.g. `data-acc-id="..."` for a clickable chip
 * option - callers own escaping any values they interpolate into it. Always keyboard-operable; pair with `attachChipKeyboardActivation`. */
export function accountChipHtml(a: AccountChipInfo, selected = false, extraAttrs = ""): string {
  return `<span class="account-chip${selected ? " sel" : ""}" style="--acc:${escapeHtml(a.colour)}" role="button" tabindex="0"${extraAttrs ? ` ${extraAttrs}` : ""}>${accountIconBadgeHtml(a)}${escapeHtml(a.label)}${apiCreditHintHtml(a)}</span>`;
}

/** Delegated Enter/Space-to-click for `.account-chip` elements, since they're
 * `<span role="button">`, not real `<button>`s. Attach once to a container
 * that outlives re-renders - each chip resolves the pick via its own click
 * listener. */
export function attachChipKeyboardActivation(container: HTMLElement): void {
  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".account-chip");
    if (!chip) return;
    e.preventDefault();
    chip.click();
  });
}
