// The figures line under an Endpoint account's row on Settings > Accounts & models:
// what its provider reports (balance, key cap, plan window) and the tokens
// Conductor counted on it. The row is drawn once with a slot, and the slot is
// repainted in place as figures arrive, so a poll never rebuilds the row's menu.

import type { Account } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { providerLine } from "../../../../shared/provider-usage-format";
import { ensureProviderUsageWatch, type ProviderUsageMap, type ProviderUsageWatch } from "../../../../shared/provider-usage-watch";

/** Latest figures per account id, fed by the watch. */
let latest: ProviderUsageMap = { usage: {}, tokens: {} };
/** Started only once an Endpoint account is in the list. */
let watch: ProviderUsageWatch | null = null;

/** The slot's contents. An unknown figure reads "Usage unknown" in the muted tone;
 * the provider's error (already key-masked by the daemon) is its tooltip only. */
export function providerUsageInnerHtml(id: string, map: ProviderUsageMap = latest): string {
  const line = providerLine(map.usage[id], map.tokens[id]);
  const tone = line.atLimit ? "is-limit" : line.figures === null ? "is-unknown" : "is-ok";
  const fig = `<span class="mp-usage-fig ${tone}"${line.error ? ` title="${escapeHtml(line.error)}"` : ""}>${escapeHtml(line.text)}</span>`;
  const pill = line.pill ? `<span class="mp-usage-pill">${escapeHtml(line.pill)}</span>` : "";
  const tok = line.tokens ? `<span class="mp-usage-tok" title="${escapeHtml(line.tokensTitle ?? "")}">${escapeHtml(line.tokens)}</span>` : "";
  return fig + pill + tok;
}

/** The slot an Endpoint row carries; empty markup for any other kind. */
export function providerUsageSlotHtml(a: Pick<Account, "id" | "kind">): string {
  if (a.kind !== "endpoint") return "";
  return `<span class="acc-sub mp-usage" data-usage-for="${escapeHtml(a.id)}">${providerUsageInnerHtml(a.id)}</span>`;
}

function paint(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".mp-usage[data-usage-for]").forEach((el) => {
    const id = el.dataset["usageFor"];
    if (id) el.innerHTML = providerUsageInnerHtml(id);
  });
}

/** Called after each list rebuild: subscribes once an Endpoint account exists,
 * and repaints the fresh slots from what is already known. */
export function ensureProviderUsage(root: HTMLElement, accounts: readonly Account[]): void {
  watch = ensureProviderUsageWatch(watch, accounts, (map) => {
    latest = map;
    paint(root);
  });
  paint(root);
}

/** Re-reads the daemon (figures and token sums) for a row's refresh. */
export async function refreshProviderUsage(): Promise<void> {
  await watch?.refresh();
}

/** Drops the subscription when the page is torn down. */
export function stopProviderUsage(): void {
  watch?.stop();
  watch = null;
  latest = { usage: {}, tokens: {} };
}
