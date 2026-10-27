// Pure helpers for the new-chat account picker (multi-account milestone 04).
// Kept free of DOM/IPC so the binding > default > fallback resolution is
// cheaply unit-testable (see tests/account-picker-logic.test.mjs).
// model-effort-data.ts is the only caller. See
// docs/multi-account/04-project-binding.md.

import { isApiCreditAccount, type AccountLite } from "../../shared/account-chip";

export type { AccountLite };

/**
 * Resolve which account a new chat in this project should pre-select:
 * 1. the project's bound account (`preferredAccountId`), if it still exists
 *    in the registry;
 * 2. else the global default (`defaultAccountId`), if it still exists;
 * 3. else, when exactly one subscription account is registered, that account
 *    (so a single-account setup never needs `default_account_id` to be set);
 * 4. else `null` when the registry has 0 or 2+ unresolved accounts - the
 *    caller must show the picker and force an explicit pick.
 *
 * An API-credit account is never returned by any step: a chat on it spends
 * the Max plan's monthly API credit, so it only starts when the user clicks
 * its chip. A binding or default that points at one (stale data; the backend
 * refuses to store either) is skipped like a removed account.
 */
export function resolveInitialAccountId(
  preferredAccountId: string | null | undefined,
  defaultAccountId: string | null | undefined,
  accounts: readonly AccountLite[],
): string | null {
  if (accounts.length === 0) return null;
  const subscriptions = accounts.filter((a) => !isApiCreditAccount(a));
  const exists = (id: string | null | undefined): id is string =>
    !!id && subscriptions.some((a) => a.id === id);
  if (exists(preferredAccountId)) return preferredAccountId;
  if (exists(defaultAccountId)) return defaultAccountId;
  if (subscriptions.length === 1) return subscriptions[0]!.id;
  return null;
}
