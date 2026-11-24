// Markup of one endpoint account row on Settings > Accounts & models. Icon, colour
// and billing label come from shared/provider-meta.ts, never from the row's own code.

import type { Account } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { accountLook, billChipHtml } from "../../../../shared/provider-meta";
import { badgeHtml } from "./role-cards";
import { providerUsageSlotHtml } from "./provider-usage-rows";
import "../../../../shared/billing-chip.css";

/** The host of a base URL, for a row's status line; the whole string when it does not parse. */
export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function statusLine(a: Account): string {
  if (a.kind === "api_credit") return "Chats bill the Max plan's monthly API credit";
  if (a.kind === "endpoint") {
    const cfg = a.endpoint;
    const n = cfg?.models.length ?? 0;
    const models = n === 0 ? "any model id" : `${n} model${n === 1 ? "" : "s"}`;
    return `Key stored by Conductor · ${cfg?.base_url ? hostOf(cfg.base_url) : "no URL yet"} · ${models}`;
  }
  return a.email ? `Signed in as ${a.email}` : "Signed in with a browser";
}

function menuItems(a: Account): string {
  const item = (act: string, icon: string, text: string, danger = false): string =>
    `<button class="menu-item${danger ? " danger" : ""}" data-act="${act}" data-id="${escapeHtml(a.id)}"><i class="ph ${icon}"></i> ${text}</button>`;
  const edit = item("edit", "ph-pencil-simple", "Edit");
  if (a.kind === "endpoint" || a.kind === "api_credit") {
    return `${edit}${item("key", "ph-key", "Replace API key")}<div class="menu-sep"></div>${item("remove", "ph-trash", "Remove", true)}`;
  }
  return `${edit}${item("reauth", "ph-arrow-clockwise", "Reauth")}<div class="menu-sep"></div>${item("remove", "ph-trash", "Remove", true)}`;
}

export function accountRowHtml(a: Account): string {
  const look = accountLook(a);
  return `<div class="acc-row" data-id="${escapeHtml(a.id)}" style="--acc:${escapeHtml(look.colour)}">${badgeHtml(a)}
    <span class="acc-info"><span class="acc-label">${escapeHtml(a.label)}${billChipHtml(look.badge)}</span>
      <span class="acc-sub"><span class="mp-ok"><i class="ph ph-check-circle"></i> ${escapeHtml(statusLine(a))}</span></span>${providerUsageSlotHtml(a)}</span>
    <span class="acc-actions"><div class="menu-anchor"><button class="icon-btn acc-btn-kebab" title="More options" aria-label="More options for ${escapeHtml(a.label)}"><i class="ph ph-dots-three-vertical"></i></button>
      <div class="menu-popover hidden">${menuItems(a)}</div></div></span></div>`;
}

/** The one provider that is not buildable yet, drawn dashed so it reads as a promise, not a row. */
export function codexRowHtml(): string {
  return `<div class="acc-row mp-static mp-later" style="--acc:var(--sb-muted)"><span class="mp-ab is-none"><i class="ph ph-robot"></i></span>
    <span class="acc-info"><span class="acc-label">ChatGPT / Codex: coming later</span><span class="acc-sub">Not available yet</span></span></div>`;
}
