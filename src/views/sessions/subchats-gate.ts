// Why "Use subchats" is unavailable for a chat, for the menu item's disabled
// tooltip. The daemon enforces the same rule in `set_subchats_on`
// (`daemon/subchats/mod.rs::API_CREDIT_REFUSAL`), which is the real gate: this
// only keeps the menu from offering what the daemon would refuse.

import { getCachedAccount } from "../../shared/accounts-cache";
import { isApiCreditAccount } from "../../shared/account-chip";

export const SUBCHATS_API_CREDIT_REASON =
  "Subchats are not available on an API-credit account, since every sub would spend its credit. Switch this chat to a subscription account first.";

/** The reason the mode cannot be turned on for a chat running under
 *  `accountId`, or undefined when it can. An account missing from the cache
 *  (not loaded yet, or a peer's) passes: unknown never blocks, and the daemon
 *  decides on the real flip. */
export function subchatsBlockedReason(accountId: string | null | undefined): string | undefined {
  return isApiCreditAccount(getCachedAccount(accountId ?? null)) ? SUBCHATS_API_CREDIT_REASON : undefined;
}
