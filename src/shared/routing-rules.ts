// Read, write and describe `Settings.routing` rules for Settings > Models &
// providers. Pure helpers: the view owns the I/O. A rule's absent field means
// "today's behaviour" for that field (the daemon's resolver falls through), so
// nothing here ever invents a default value for the user.

import type { Account, RouteFallback, RouteRange, RouteRule, RoutingConfig } from "../types/ipc.generated";
import { EFFORTS, MODELS } from "./effort-presets";

export interface PaymentGroupMeta {
  id: string;
  label: string;
  /** Phosphor class of the tab and of a project chip. */
  icon: string;
  chipIcon: string;
}

/** The two groups the page offers; the data model takes more. */
export const PAYMENT_GROUPS: readonly PaymentGroupMeta[] = [
  { id: "personal", label: "Personal projects", icon: "ph-user", chipIcon: "ph-folder-simple" },
  { id: "client", label: "Client projects", icon: "ph-briefcase", chipIcon: "ph-briefcase" },
];

/** A project with no `payment_group` reads as personal (docs/architecture/providers.md). */
export function projectGroup(p: { payment_group?: string | null }): string {
  return p.payment_group?.trim() || "personal";
}

export function readRule(routing: RoutingConfig | undefined, group: string, kind: string): RouteRule | undefined {
  return routing?.groups?.[group]?.[kind];
}

/** A rule with nothing set is no rule: dropping empty fields keeps `settings.json` free of `{}` entries. */
export function normalizeRule(rule: RouteRule): RouteRule | null {
  const out: RouteRule = {};
  if (rule.account_id) out.account_id = rule.account_id;
  if (rule.model) out.model = rule.model;
  if (rule.effort) out.effort = rule.effort;
  if (rule.fallback) out.fallback = rule.fallback;
  if (rule.range) {
    const range: RouteRange = {};
    for (const k of ["min_model", "max_model", "min_effort", "max_effort"] as const) {
      if (rule.range[k]) range[k] = rule.range[k];
    }
    // An empty range object still means "the main chat may flex", so it survives.
    out.range = range;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A copy of `routing` with the rule for (group, kind) set, or removed when `rule` is null or empty. Never mutates its input. */
export function writeRule(routing: RoutingConfig | undefined, group: string, kind: string, rule: RouteRule | null): RoutingConfig {
  const groups: RoutingConfig["groups"] = {};
  for (const [g, kinds] of Object.entries(routing?.groups ?? {})) groups[g] = { ...kinds };
  const kinds = { ...(groups[group] ?? {}) };
  const next = rule ? normalizeRule(rule) : null;
  if (next) kinds[kind] = next;
  else delete kinds[kind];
  groups[group] = kinds;
  return { ...routing, groups };
}

/** Whether a rule can name this account: every kind except API credit (the daemon refuses it). */
export function isRoutableAccount(a: { kind?: string }): boolean {
  return a.kind !== "api_credit";
}

export function isEndpoint(a: { kind?: string } | undefined): boolean {
  return a?.kind === "endpoint";
}

/** Model ids a rule on this account may pick: the Claude families, or the Endpoint account's own list. */
export function modelChoices(account: Pick<Account, "kind" | "endpoint"> | undefined, claudeModels: readonly string[] = MODELS): string[] {
  if (isEndpoint(account)) return [...(account?.endpoint?.models ?? [])];
  return [...claudeModels];
}

/** Efforts a rule on this account offers. An endpoint's server may not honour all five, so it gets the three common ones. */
export function effortChoices(account: { kind?: string } | undefined): string[] {
  return isEndpoint(account) ? ["low", "medium", "high"] : [...EFFORTS];
}

/** Bars to fill for `effort`, out of the bars this account's own ladder has: the top rung of a three-rung endpoint ladder is 3 of 3, never 3 of 5. An unset effort, or one off the ladder, fills nothing and `of` is 0 so the caller draws the label alone. */
export function effortFill(effort: string | undefined, account: { kind?: string } | undefined): { filled: number; of: number } {
  const ladder = effortChoices(account);
  const at = ladder.indexOf(effort ?? "");
  return at < 0 ? { filled: 0, of: 0 } : { filled: at + 1, of: ladder.length };
}

/** Whether `model` is a value the model select can show for this account (else it is a free-text id). */
export function modelIsListed(account: Pick<Account, "kind" | "endpoint"> | undefined, model: string, claudeModels: readonly string[] = MODELS): boolean {
  return modelChoices(account, claudeModels).includes(model);
}

/** Same rule as `accounts::is_valid_endpoint_model`: 1-128 of `[A-Za-z0-9._:/~\[\]-]`, no leading `-`. */
export function isValidEndpointModelId(id: string): boolean {
  return /^[A-Za-z0-9._:/~[\]-]{1,128}$/.test(id) && !id.startsWith("-");
}

/** The rule after its account changed: a model not listed on the new account, an effort it lacks, the range and a fallback naming the account itself are dropped. */
export function withAccount(rule: RouteRule, accountId: string | undefined, account: Pick<Account, "kind" | "endpoint"> | undefined, claudeModels: readonly string[] = MODELS): RouteRule {
  const next: RouteRule = { ...rule };
  if (accountId) next.account_id = accountId;
  else delete next.account_id;
  // A model id means something per account ("opus" is valid text on an Endpoint account but not a model there), so only a listed one carries over.
  if (next.model && !modelIsListed(account, next.model, claudeModels)) delete next.model;
  if (next.effort && !effortChoices(account).includes(next.effort)) delete next.effort;
  delete next.range;
  if (next.fallback?.kind === "account" && next.fallback.account_id === accountId) delete next.fallback;
  return next;
}

/** Range bounds listed lowest to highest: Claude families by tier, an Endpoint account's models by list position. */
export function rangeModels(account: Pick<Account, "kind" | "endpoint"> | undefined, claudeModels: readonly string[] = MODELS): string[] {
  return modelChoices(account, claudeModels);
}

export function rangeEfforts(account: { kind?: string } | undefined): string[] {
  return effortChoices(account);
}

/** A range spanning everything the account offers: the state the "may raise or lower" switch starts from. */
export function fullRange(account: Pick<Account, "kind" | "endpoint"> | undefined, claudeModels: readonly string[] = MODELS): RouteRange {
  const models = rangeModels(account, claudeModels);
  const efforts = rangeEfforts(account);
  const range: RouteRange = {};
  if (models.length) { range.min_model = models[0]; range.max_model = models[models.length - 1]; }
  if (efforts.length) { range.min_effort = efforts[0]; range.max_effort = efforts[efforts.length - 1]; }
  return range;
}

// ── Per-project overrides (`ProjectConfig.routing_overrides`) ───────────────
// Same rule shape as a group's, so the role sheet edits either one.

export type RouteOverrides = { [kind: string]: RouteRule | undefined };

/** A copy of `overrides` with the rule for `kind` set, or removed when `rule` is null or empty. Never mutates its input. */
export function writeOverride(overrides: RouteOverrides | undefined, kind: string, rule: RouteRule | null): RouteOverrides {
  const out: RouteOverrides = {};
  for (const [k, r] of Object.entries(overrides ?? {})) if (r) out[k] = r;
  const next = rule ? normalizeRule(rule) : null;
  if (next) out[kind] = next;
  else delete out[kind];
  return out;
}

/** Kinds a project overrides, in the order `order` lists them; kinds the page does not know follow, alphabetically, so a daemon-side kind still shows a row. */
export function overriddenKinds(overrides: RouteOverrides | undefined, order: readonly string[]): string[] {
  const have = Object.keys(overrides ?? {}).filter((k) => overrides?.[k]);
  const known = order.filter((k) => have.includes(k));
  return [...known, ...have.filter((k) => !order.includes(k)).sort()];
}

/** The rule a new override starts from: a copy of the payment group's rule for that kind (or nothing), so the sheet opens showing what the project gets today. */
export function seedOverride(routing: RoutingConfig | undefined, group: string, kind: string): RouteRule {
  const rule = readRule(routing, group, kind);
  if (!rule) return {};
  return { ...rule, ...(rule.range ? { range: { ...rule.range } } : {}) };
}

// A link in a project's rail opens Settings > Accounts & models on one group's Who does what tab: the rail names the group here, the page takes it once when it mounts.
let requestedGroupTab: string | null = null;
export function requestGroupTab(group: string): void { requestedGroupTab = group; }
export function takeRequestedGroupTab(): string | null {
  const g = requestedGroupTab;
  requestedGroupTab = null;
  return g;
}

export function fallbackValue(f: RouteFallback | undefined): string {
  if (!f) return "";
  return f.kind === "wait" ? "wait" : `account:${f.account_id}`;
}

export function parseFallback(v: string): RouteFallback | undefined {
  if (v === "wait") return { kind: "wait" };
  if (v.startsWith("account:") && v.length > "account:".length) return { kind: "account", account_id: v.slice("account:".length) };
  return undefined;
}
