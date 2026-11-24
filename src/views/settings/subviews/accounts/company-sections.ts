// The Accounts tab of Settings > Accounts & models: a billing legend, then one
// section per company. A company with accounts shows them under a header with a
// small Add button; a company with none shows a dashed Add row that is also its
// add flow. Pure markup: the page owns the rows' wiring.

import type { EndpointPreset } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { BILLING, PROVIDER_META, billChipHtml, type AccountBadge, type ProviderId } from "../../../../shared/provider-meta";
import { codexRowHtml } from "../models-providers/account-rows";
import "../../../../shared/billing-chip.css";

/** What a section's Add button or dashed row asks the page to open. */
export type AddTarget = "anthropic" | EndpointPreset;

interface CompanyText {
  /** Under the name, beside the Add button. */
  sub: string;
  /** Under the dashed Add row of a company with no account. */
  none: string;
}

// Icon, colour and name come from PROVIDER_META; only the prose lives here.
const TEXT: Readonly<Record<AddTarget, CompanyText>> = {
  anthropic: { sub: "Sign in with a plan, or use an API key on your Max credit", none: "Sign in with a Pro or Max plan, or add an API-credit key." },
  kimi_code: { sub: "Coding subscription", none: "Run chats on Kimi with your subscription key." },
  deepseek: { sub: "Pay per token", none: "Run chats on DeepSeek with an API key." },
  openrouter: { sub: "Many companies behind one key", none: "One key, models from many companies." },
  custom: { sub: "Any Anthropic-compatible URL", none: "Point Conductor at your own endpoint." },
};

/** The order the sections appear in, after Anthropic. */
export const ENDPOINT_COMPANIES: readonly EndpointPreset[] = ["kimi_code", "deepseek", "openrouter", "custom"];

const providerOf = (t: AddTarget): ProviderId => (t === "anthropic" ? "claude" : t);

export function addLabel(t: AddTarget): string {
  return t === "anthropic" ? "Add account" : `Add ${PROVIDER_META[t].label}`;
}

/** The legend on top: what each billing label means. The phone has no endpoint, so it never meets "Pay per token". */
export function legendHtml(remote: boolean): string {
  const keys: AccountBadge[] = remote ? ["Subscription", "Included credit"] : ["Subscription", "Included credit", "Pay per token"];
  return `<div class="acm-legend"><div class="acm-legend-title"><i class="ph ph-receipt"></i> How a chat is billed</div>
    ${keys.map((k) => `<div class="acm-legend-row">${billChipHtml(k)}<span>${escapeHtml(BILLING[k].text)}</span></div>`).join("")}</div>`;
}

export interface SectionInput {
  target: AddTarget;
  /** Account rows, already drawn. Empty draws the dashed Add row. */
  rows: readonly string[];
  /** Always drawn after the rows, and never counted as one (the Terminal row of Anthropic). */
  trailing?: string;
}

export function sectionHtml(o: SectionInput): string {
  const meta = PROVIDER_META[providerOf(o.target)];
  const text = TEXT[o.target];
  const name = o.target === "anthropic" ? "Anthropic (Claude)" : meta.label;
  const has = o.rows.length > 0;
  const label = addLabel(o.target);
  return `<div class="acm-prov" data-company="${o.target}" style="--acc:${escapeHtml(meta.colour)}">
    <div class="acm-prov-head"><span class="mp-ab"><i class="${escapeHtml(meta.icon)}"></i></span><span class="acm-prov-name">${escapeHtml(name)}</span><span class="acm-prov-sub">${escapeHtml(text.sub)}</span>
      ${has ? `<button type="button" class="btn-secondary acm-add" data-add="${o.target}"><i class="ph ph-plus"></i> ${escapeHtml(label)}</button>` : ""}</div>
    <div class="acc-list">${has ? o.rows.join("") : `<button type="button" class="acm-add-row" data-add="${o.target}"><i class="ph ph-plus"></i><span><b>${escapeHtml(label)}</b><small>${escapeHtml(text.none)}</small></span></button>`}${o.trailing ?? ""}</div></div>`;
}

/** The dim promise row, drawn as its own section so it reads like the others. */
export function codexSectionHtml(): string {
  return `<div class="acm-prov acm-prov-later">${codexRowHtml()}</div>`;
}
