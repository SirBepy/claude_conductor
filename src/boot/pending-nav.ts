// The Chats window's queued navigation. A jump requested while the window was
// still being built (the overlay's account card on a cold start) is stashed on
// the backend as a string and drained once at boot; this maps that string onto
// the same navigation the live `navigate-to-*` events perform.

export interface PendingNavDeps {
  /** The router's `window.navigateTo`. */
  navigateTo: (view: string) => Promise<void>;
  /** Marks an account as the dashboard's focused one; must run before the dashboard shows. */
  focusAccount: (accountId: string) => Promise<void>;
}

const ACCOUNT_PREFIX = "account:";

/** Runs one drained `take_pending_nav` value. An empty drain or a target this
 *  build does not know is dropped, since a stale stash must not strand the window. */
export async function applyPendingNav(nav: string | null | undefined, deps: PendingNavDeps): Promise<void> {
  if (!nav) return;
  if (nav === "dashboard" || nav === "settings-accounts") {
    await deps.navigateTo(nav);
  } else if (nav.startsWith(ACCOUNT_PREFIX)) {
    await deps.focusAccount(nav.slice(ACCOUNT_PREFIX.length));
    await deps.navigateTo("dashboard");
  }
}
