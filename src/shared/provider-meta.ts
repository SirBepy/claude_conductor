// The one table that says how each kind of account looks and what a preset
// prefills: icon, colour and billing label per provider. Settings > Accounts &
// models reads it for the account rows, the role cards and the Add account
// modals; nothing else keeps its own copy of a provider's icon or colour.
// A Claude plan account keeps the icon and colour its owner picked (they are
// stored on the account); only the kinds without such a choice live here.

import type { Account, EndpointAuth, EndpointPreset } from "../types/ipc.generated";

export type ProviderId = "claude" | "api_credit" | EndpointPreset;
/** The three ways a chat is billed. A flat fee with limits set by the provider is one label whether it is a Claude plan or Kimi Code. */
export type AccountBadge = "Subscription" | "Included credit" | "Pay per token";

export interface BillingMeta {
  label: AccountBadge;
  colour: string;
  /** One sentence for the legend and the "Billed as" line. */
  text: string;
}

export const BILLING: Readonly<Record<AccountBadge, BillingMeta>> = {
  "Subscription": { label: "Subscription", colour: "#e0a64e", text: "A flat monthly fee. The provider sets the limits (Claude: a 5-hour and a weekly window)." },
  "Included credit": { label: "Included credit", colour: "#10b981", text: "Your Max plan includes some API credit each month. Chats use it up, then stop." },
  "Pay per token": { label: "Pay per token", colour: "#9a7dfc", text: "You are charged for each request, with no cap. Conductor shows no usage meter." },
};

/** The coloured chip of one billing label. Styled by `.mp-badge` in shared/billing-chip.css, which no page scope gates, so a modal on the host draws it too. */
export function billChipHtml(badge: AccountBadge): string {
  return `<span class="mp-badge" style="--acc:${BILLING[badge].colour}">${BILLING[badge].label}</span>`;
}

/** The "Billed as <chip> <sentence>" line of an add form or a kind card. */
export function billedAsHtml(badge: AccountBadge): string {
  return `<i class="ph ph-receipt"></i><span>Billed as ${billChipHtml(badge)} ${BILLING[badge].text}</span>`;
}

export interface ProviderMeta {
  id: ProviderId;
  /** The name the Add account modal's provider select and a new account's label start from. */
  label: string;
  /** Phosphor classes, weight included (`ph-fill ph-moon-stars`). */
  icon: string;
  colour: string;
  badge: AccountBadge;
}

export const PROVIDER_META: Readonly<Record<ProviderId, ProviderMeta>> = {
  claude: { id: "claude", label: "Claude subscription", icon: "ph-fill ph-sparkle", colour: "#d97757", badge: "Subscription" },
  api_credit: { id: "api_credit", label: "API credit", icon: "ph ph-key", colour: "#10b981", badge: "Included credit" },
  kimi_code: { id: "kimi_code", label: "Kimi Code", icon: "ph-fill ph-moon-stars", colour: "#4ea1ff", badge: "Subscription" },
  deepseek: { id: "deepseek", label: "DeepSeek", icon: "ph-fill ph-fish", colour: "#6f86ff", badge: "Pay per token" },
  openrouter: { id: "openrouter", label: "OpenRouter", icon: "ph-fill ph-shuffle", colour: "#9a7dfc", badge: "Pay per token" },
  custom: { id: "custom", label: "Custom endpoint", icon: "ph ph-plugs-connected", colour: "#8a8fa3", badge: "Pay per token" },
};

export interface EndpointPresetSpec {
  baseUrl: string;
  authStyle: EndpointAuth;
  /** Model ids the model picker offers; empty = the provider serves any id. */
  models: readonly string[];
}

/** From the vendors' docs, UNVERIFIED until a real key is tried (docs/architecture/providers.md). */
export const ENDPOINT_PRESETS: Readonly<Record<Exclude<EndpointPreset, "custom">, EndpointPresetSpec>> = {
  kimi_code: { baseUrl: "https://api.kimi.ai/coding/", authStyle: "bearer", models: ["k3.1-pro", "kimi-for-coding"] },
  deepseek: { baseUrl: "https://api.deepseek.com/anthropic", authStyle: "bearer", models: ["deepseek-v4-pro", "deepseek-flash"] },
  openrouter: { baseUrl: "https://openrouter.ai/api", authStyle: "bearer", models: [] },
};

/** The provider an account belongs to. A missing `kind` is a subscription (older daemons and peers). */
export function providerIdOf(a: Pick<Account, "kind" | "endpoint"> | { kind?: string; endpoint?: { preset?: EndpointPreset } | null }): ProviderId {
  if (a.kind === "api_credit") return "api_credit";
  if (a.kind === "endpoint") return a.endpoint?.preset ?? "custom";
  return "claude";
}

export interface AccountLook {
  icon: string;
  colour: string;
  badge: AccountBadge;
}

/** How one account draws: its own stored icon and colour for a Claude plan, the table's for the rest. */
export function accountLook(a: { kind?: string; icon?: string; colour?: string; endpoint?: { preset?: EndpointPreset } | null }): AccountLook {
  const id = providerIdOf(a);
  const meta = PROVIDER_META[id];
  if (id === "claude") {
    return { icon: `ph ph-${a.icon || "user"}`, colour: a.colour || meta.colour, badge: meta.badge };
  }
  return { icon: meta.icon, colour: meta.colour, badge: meta.badge };
}
