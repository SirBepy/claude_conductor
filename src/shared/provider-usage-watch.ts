// One live view of every Endpoint account's provider figures, shared by the
// Accounts rows, the Change account picker and the overlay: a
// `get_provider_usage` read on start, then each `provider-usage-changed` event
// replaces that account's entry. In memory only: the daemon owns the figures
// and re-serves them on open. The token sums only move on a read, so a caller
// that wants fresh ones calls `refresh()`.

import { api } from "./api";
import { isEndpointAccount, type AccountKindLite } from "./account-chip";
import type { AccountTokens, ProviderUsage } from "../types/ipc.generated";

export interface ProviderUsageMap {
  usage: Partial<Record<string, ProviderUsage>>;
  tokens: Partial<Record<string, AccountTokens>>;
}

export interface ProviderUsageWatch {
  stop: () => void;
  /** Re-reads the daemon (figures and token sums), then reports. */
  refresh: () => Promise<void>;
}

/** Calls `onChange` with the whole map after each read and each event. An event
 * that lands before the first read resolves wins over that read's copy of the
 * same account, since it is newer. */
export function watchProviderUsage(onChange: (map: ProviderUsageMap) => void): ProviderUsageWatch {
  let disposed = false;
  let fetched: ProviderUsageMap = { usage: {}, tokens: {} };
  const fromEvents: Record<string, ProviderUsage> = {};

  const emit = (): void => {
    if (!disposed) onChange({ usage: { ...fetched.usage, ...fromEvents }, tokens: fetched.tokens });
  };
  const read = async (): Promise<void> => {
    const view = await api.getProviderUsage();
    fetched = { usage: view.usage, tokens: view.tokens };
    emit();
  };

  const unlisten = api.onProviderUsageChanged((change) => {
    fromEvents[change.account_id] = change.usage;
    emit();
  });
  void read();

  return {
    stop: () => { disposed = true; unlisten(); },
    refresh: read,
  };
}

/** Starts the watch only once an Endpoint account exists, so a Claude-only
 * setup never asks the daemon for figures, and only once per holder: pass back
 * what the last call returned and it is returned untouched while one is live. */
export function ensureProviderUsageWatch(
  current: ProviderUsageWatch | null,
  accounts: readonly { kind?: AccountKindLite }[],
  onChange: (map: ProviderUsageMap) => void,
): ProviderUsageWatch | null {
  if (current || !accounts.some(isEndpointAccount)) return current;
  return watchProviderUsage(onChange);
}
