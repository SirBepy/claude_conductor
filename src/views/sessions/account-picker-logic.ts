// Pure helpers for the new-chat account picker (multi-account milestone 04).
// Kept free of DOM/IPC so the binding > default > fallback resolution is
// cheaply unit-testable (see tests/account-picker-logic.test.mjs).
// model-effort-modal.ts is the only caller. See
// docs/multi-account/04-project-binding.md.

import type { AccountLite } from "../../shared/account-chip";

export type { AccountLite };

/**
 * Resolve which account a new chat in this project should pre-select:
 * 1. the project's bound account (`preferredAccountId`), if it still exists
 *    in the registry;
 * 2. else the global default (`defaultAccountId`), if it still exists;
 * 3. else, when exactly one account is registered, that account (so a
 *    single-account setup never needs `default_account_id` to be set);
 * 4. else `null` when the registry has 0 or 2+ unresolved accounts - the
 *    caller must show the picker and force an explicit pick.
 */
export function resolveInitialAccountId(
  preferredAccountId: string | null | undefined,
  defaultAccountId: string | null | undefined,
  accounts: readonly AccountLite[],
): string | null {
  if (accounts.length === 0) return null;
  const exists = (id: string | null | undefined): id is string =>
    !!id && accounts.some((a) => a.id === id);
  if (exists(preferredAccountId)) return preferredAccountId;
  if (exists(defaultAccountId)) return defaultAccountId;
  if (accounts.length === 1) return accounts[0]!.id;
  return null;
}
