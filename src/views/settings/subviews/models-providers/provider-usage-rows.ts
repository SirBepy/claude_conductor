// The figures line under an Endpoint account's row on Settings > Accounts & models:
// what its provider reports (balance, key cap, plan window) and the tokens
// Conductor counted on it. The row is drawn once with a slot, and the slot is
// repainted in place as figures arrive, so a poll never rebuilds the row's menu.

import type { Account } from "../../../../types/ipc.generated";
import { api } from "../../../../shared/api";
import { escapeHtml } from "../../../../shared/escape-html";
import { providerLine } from "../../../../shared/provider-usage-format";
import { ensureProviderUsageWatch, type ProviderUsageMap, type ProviderUsageWatch } from "../../../../shared/provider-usage-watch";
import "../../../../styles/toggle-switch.css";

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

const SWITCH_HINT = "Asks Kimi's usage route with your stored key about every 10 minutes. That route is not in Kimi's published docs, so it stays off until you turn it on.";

/** The "Show plan usage" switch. Only a Kimi Code row has one: DeepSeek and OpenRouter
 * read documented routes and are always on. Drawn outside the repainted slot so a
 * poll never swaps the input under a click. */
function planUsageSwitchHtml(a: Pick<Account, "id" | "endpoint">): string {
  if (a.endpoint?.preset !== "kimi_code") return "";
  const on = latest.planUsage?.[a.id] === true;
  return `<span class="acc-sub mp-plan-switch" title="${escapeHtml(SWITCH_HINT)}"><label class="switch"><input type="checkbox" data-plan-usage="${escapeHtml(a.id)}" aria-label="Show plan usage"${on ? " checked" : ""}><span class="slider"></span></label><span class="mp-plan-switch-text">Show plan usage</span></span>`;
}

/** The slot an Endpoint row carries (its figures, plus the plan-usage switch for a
 * Kimi Code row); empty markup for any other kind. */
export function providerUsageSlotHtml(a: Pick<Account, "id" | "kind" | "endpoint">): string {
  if (a.kind !== "endpoint") return "";
  return `<span class="acc-sub mp-usage" data-usage-for="${escapeHtml(a.id)}">${providerUsageInnerHtml(a.id)}</span>${planUsageSwitchHtml(a)}`;
}

function paint(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".mp-usage[data-usage-for]").forEach((el) => {
    const id = el.dataset["usageFor"];
    if (id) el.innerHTML = providerUsageInnerHtml(id);
  });
  root.querySelectorAll<HTMLInputElement>("input[data-plan-usage]").forEach((input) => {
    // A switch mid-flight keeps what the click set until its own call settles.
    if (input.disabled) return;
    input.checked = latest.planUsage?.[input.dataset["planUsage"] ?? ""] === true;
  });
}

/** One delegated listener on the account list for every row's switch. Disabled while
 * the call runs; a refusal puts the switch back and says why. */
export function wirePlanUsageSwitch(list: HTMLElement, onError: (message: string) => void): void {
  list.addEventListener("change", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-plan-usage]");
    const id = input?.dataset["planUsage"];
    if (!input || !id) return;
    const on = input.checked;
    input.disabled = true;
    void (async () => {
      try {
        await api.setProviderUsageSwitch(id, on);
        await refreshProviderUsage();
      } catch (err) {
        console.error("[provider-usage] set_provider_usage_switch failed", err);
        onError(err instanceof Error ? err.message : String(err));
        input.checked = !on;
      } finally {
        input.disabled = false;
        paint(list);
      }
    })();
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
