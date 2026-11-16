// "Show the changelog once after an update" bookkeeping. The pending flag is
// persisted so that a launch which never reached the empty screen (a chat
// restored straight away) still shows the changelog the next time the empty
// screen draws; in-memory would lose it with the restart.

import { ENTRIES, type ChangelogEntry } from "../../../changelog/entries";

const PENDING_KEY = "whatsNewPendingVersion";

/** Fired on `window` when an update was just detected, so an empty screen that
 *  drew before the async version check finished can open its panel. */
export const PENDING_EVENT = "whats-new-pending";

export function latestEntry(entries: ChangelogEntry[] = ENTRIES): ChangelogEntry | null {
  return entries[0] ?? null;
}

export function pendingVersion(): string | null {
  try { return localStorage.getItem(PENDING_KEY); } catch { return null; }
}

export function clearPending(): void {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* storage blocked */ }
}

/** Records that the app now runs a version the user has not seen before. Only
 *  the update-toast version check calls it: a fresh install records nothing,
 *  so nobody is shown "what changed" for a version they never had. */
export function markUpdatedTo(version: string): void {
  try { localStorage.setItem(PENDING_KEY, version); } catch { /* storage blocked */ }
  window.dispatchEvent(new CustomEvent(PENDING_EVENT));
}

/** True when the pending update has a changelog entry to show. A release with
 *  no entry never auto-opens a panel about some other version. */
export function autoOpenWanted(entries: ChangelogEntry[] = ENTRIES): boolean {
  const latest = latestEntry(entries);
  return latest !== null && pendingVersion() === latest.version;
}
