// Markup for the project rail's Payment group block: the rows of the kinds this
// project overrides, and the menu of the kinds it does not. Pure, so a unit test
// can read the text without a DOM-wired view.
import type { Account, RouteRule } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { routingKind, ROUTING_KINDS } from "../../../../shared/routing-kinds";
import type { RouteOverrides } from "../../../../shared/routing-rules";
import { badgeHtml, ruleShortText, ruleView } from "../../../settings/subviews/models-providers/role-cards";

/** The select's option labels: a project is one of these, not a "group". */
export const GROUP_OPTION_LABELS: Readonly<Record<string, string>> = { personal: "Personal project", client: "Client project" };

/** "Personal" / "Client" for the link and the sheet's scope line; a group the page does not name reads as its id. */
export function groupShortName(group: string): string {
  const label = GROUP_OPTION_LABELS[group];
  return label ? label.split(" ")[0]! : group;
}

const kindMeta = (kind: string): { label: string; icon: string } => routingKind(kind) ?? { label: kind, icon: "ph ph-sliders-horizontal" };

/** One overridden kind: its role icon and label, what the project runs it on, and what the payment group would have run. */
export function overrideRowHtml(kind: string, override: RouteRule, groupRule: RouteRule | undefined, accounts: readonly Account[]): string {
  const meta = kindMeta(kind);
  const v = ruleView(override, accounts);
  return `<button type="button" class="mp-diff" data-kind="${escapeHtml(kind)}" aria-label="${escapeHtml(`${meta.label}: ${ruleShortText(override, accounts)} instead of ${ruleShortText(groupRule, accounts)}`)}">
    <span class="mp-rb sm"><i class="${escapeHtml(meta.icon)}"></i></span>
    <span class="t"><b>${escapeHtml(meta.label)}</b><span>${badgeHtml(v.account, true)}<em>${escapeHtml(ruleShortText(override, accounts))}</em></span><span>instead of ${escapeHtml(ruleShortText(groupRule, accounts))}</span></span>
    <i class="ph ph-caret-right mp-go"></i>
  </button>`;
}

/** The kinds a project does not override yet, in the page's order. */
export function freeKinds(overrides: RouteOverrides | undefined): string[] {
  return ROUTING_KINDS.map((k) => k.id).filter((k) => !overrides?.[k]);
}

export function menuItemsHtml(kinds: readonly string[]): string {
  if (!kinds.length) return `<div class="pg-hint ps-menu-empty">Every role is already changed.</div>`;
  return kinds.map((k) => {
    const meta = kindMeta(k);
    return `<button type="button" class="menu-item" role="menuitem" data-kind="${escapeHtml(k)}"><i class="${escapeHtml(meta.icon)}"></i> ${escapeHtml(meta.label)}</button>`;
  }).join("");
}
