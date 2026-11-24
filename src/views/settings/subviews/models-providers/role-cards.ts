// Markup for the "Who does what" cards and the summary strip of the role sheet.
// A field the rule leaves unset reads "Default": the daemon then behaves as it
// did before routing existed. Given the app-wide defaults (`DefaultSpec`) the
// row names what that is today (default account, model, effort); without them
// it says only "Same as today" rather than show a value nothing enforces.

import type { Account, RouteRule, RoutingConfig } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { modelDisplayLabel, readGlobalDefault } from "../../../../shared/effort-presets";
import { accountLook } from "../../../../shared/provider-meta";
import { ROUTING_KIND_GROUPS, ROUTING_KINDS, type RoutingKindMeta } from "../../../../shared/routing-kinds";
import { effortFill, isEndpoint, readRule } from "../../../../shared/routing-rules";

/** What a chat opens on when no rule, project or pick says otherwise: Settings' default account, model and effort. */
export interface DefaultSpec {
  account: Account | null;
  model: string;
  effort: string;
}

export function defaultSpec(settings: Record<string, unknown>, accounts: readonly Account[]): DefaultSpec {
  const id = settings["default_account_id"];
  const account = typeof id === "string" ? accounts.find((a) => a.id === id) ?? null : null;
  return { account, ...readGlobalDefault(settings) };
}

export interface RuleView {
  /** True when no rule exists for this kind at all. */
  isDefault: boolean;
  /** A default row that names the app-wide default account, model and effort instead of just "Default". */
  fromDefaults: boolean;
  account: Account | null;
  /** The rule names an account that no longer exists. */
  accountMissing: boolean;
  accountText: string;
  modelText: string;
  effort: string;
  effortText: string;
  /** Bars filled out of `levels`, the ladder of the rule's own account; `levels` 0 = no bars, label only. */
  level: number;
  levels: number;
  fallbackText: string;
  fallbackIcon: string;
  flexible: boolean;
}

export function ruleView(rule: RouteRule | undefined, accounts: readonly Account[], defaults?: DefaultSpec): RuleView {
  const fromDefaults = !rule && !!defaults;
  const account = fromDefaults ? defaults.account : rule?.account_id ? accounts.find((a) => a.id === rule.account_id) ?? null : null;
  const accountMissing = !!rule?.account_id && !account;
  const f = rule?.fallback;
  let fallbackText = "At its limit: not set";
  let fallbackIcon = "ph-hourglass-simple";
  if (f?.kind === "wait") { fallbackText = "At its limit: wait"; fallbackIcon = "ph-hourglass-medium"; }
  else if (f?.kind === "account") {
    const to = accounts.find((a) => a.id === f.account_id);
    fallbackText = `At its limit: ${to ? to.label : "a removed account"}`;
    fallbackIcon = "ph-arrow-bend-down-right";
  }
  const effort = fromDefaults ? defaults.effort : rule?.effort;
  const fill = effortFill(effort, account ?? undefined);
  // An Endpoint default account runs its own first model, never a Claude family.
  const defaultModel = isEndpoint(account ?? undefined) ? account?.endpoint?.models?.[0] ?? "Its own model" : modelDisplayLabel(defaults?.model ?? "");
  return {
    isDefault: !rule,
    fromDefaults,
    account,
    accountMissing,
    accountText: account ? account.label : accountMissing ? "Removed account" : "Default account",
    modelText: fromDefaults ? defaultModel : rule?.model ? (isEndpoint(account ?? undefined) ? rule.model : modelDisplayLabel(rule.model)) : "Default model",
    effort: effort ?? "default",
    effortText: effort ?? "default",
    level: fill.filled,
    levels: fill.of,
    fallbackText,
    fallbackIcon,
    flexible: !!rule?.range,
  };
}

/** One short phrase for what a rule runs: its model, else its account, else "the default". Reads "the default" for no rule, matching a project row's "instead of ..." line. */
export function ruleShortText(rule: RouteRule | undefined, accounts: readonly Account[]): string {
  const v = ruleView(rule, accounts);
  if (rule?.model) return v.modelText;
  if (rule?.account_id) return v.accountText;
  return "the default";
}

export function badgeHtml(account: Account | null, small = false): string {
  if (!account) return `<span class="mp-ab${small ? " sm" : ""} is-none"><i class="ph ph-circle-dashed"></i></span>`;
  const look = accountLook(account);
  return `<span class="mp-ab${small ? " sm" : ""}" style="--acc:${escapeHtml(look.colour)}"><i class="${escapeHtml(look.icon)}"></i></span>`;
}

/** One bar per rung of the account's effort ladder; none at all when there is no ladder position to show. */
export function pipsHtml(level: number, levels: number): string {
  if (levels <= 0) return "";
  return `<span class="mp-pips" aria-hidden="true">${Array.from({ length: levels }, (_, i) => `<i class="${i < level ? "f" : ""}"></i>`).join("")}</span>`;
}

/** The account, model and effort strip shared by a card and the sheet's summary. */
export function mainHtml(v: RuleView): string {
  const sub = v.fromDefaults ? `Default · ${v.accountText}` : v.isDefault ? "Same as today" : v.accountText;
  const showsValue = !v.isDefault || v.fromDefaults;
  return `${badgeHtml(v.account)}<span class="m"><b>${escapeHtml(showsValue ? v.modelText : "Default")}</b><span>${escapeHtml(sub)}</span></span>
    ${!showsValue ? "" : `<span class="mp-eff">${pipsHtml(v.level, v.levels)}<small>${escapeHtml(v.effortText)}</small></span>`}`;
}

export function cardHtml(kind: RoutingKindMeta, rule: RouteRule | undefined, accounts: readonly Account[], group: string, defaults?: DefaultSpec): string {
  const v = ruleView(rule, accounts, defaults);
  const acc = v.account ? accountLook(v.account).colour : "var(--sb-muted)";
  // A row with a rule that has nothing past its account, model and effort (no fallback, not flexible) needs no second line.
  const hasFoot = !v.isDefault && (v.fallbackIcon !== "ph-hourglass-simple" || v.flexible);
  return `<button type="button" class="mp-card${v.isDefault ? " is-default" : ""}" style="--acc:${escapeHtml(acc)}" data-kind="${escapeHtml(kind.id)}" data-group="${escapeHtml(group)}" aria-label="${escapeHtml(kind.label)}: ${escapeHtml(v.fromDefaults ? `default, ${v.modelText} on ${v.accountText}` : v.isDefault ? "default" : `${v.modelText} on ${v.accountText}`)}">
    <span class="mp-card-head"><span class="mp-rb"><i class="${escapeHtml(kind.icon)}"></i></span><span class="t"><b>${escapeHtml(kind.label)}</b><span class="s">${escapeHtml(kind.blurb)}</span></span></span>
    <span class="mp-card-main">${mainHtml(v)}</span>
    <i class="ph ph-caret-right mp-go"></i>
    ${hasFoot ? `<span class="mp-card-foot">${v.fallbackIcon !== "ph-hourglass-simple" ? `<i class="ph ${v.fallbackIcon}"></i> ${escapeHtml(v.fallbackText)}` : ""}${v.flexible ? `<span class="flex" title="Main chat may raise or lower this"><i class="ph ph-arrows-down-up"></i> flexible</span>` : ""}</span>` : ""}
  </button>`;
}

/** Both card groups of one payment group's tab. */
export function cardsHtml(group: string, routing: RoutingConfig | undefined, accounts: readonly Account[], defaults?: DefaultSpec): string {
  return ROUTING_KIND_GROUPS.map((g) =>
    `<div class="mp-gt">${escapeHtml(g.title)}</div><div class="mp-cards">${ROUTING_KINDS.filter((k) => k.group === g.id)
      .map((k) => cardHtml(k, readRule(routing, group, k.id), accounts, group, defaults)).join("")}</div>`).join("");
}
