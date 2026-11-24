// Phone only: while the app idles on the chat list, fetch the newest transcript
// page of the chats most likely to be tapped next into history-page-cache, so
// the tap paints from storage instead of waiting on the tunnel. Reads run one at
// a time and flagged `background`, so a slow link never queues them ahead of a
// request the user is waiting on and the "Waiting for your PC" strip stays quiet.

import { invoke } from "../ipc";
import { isRemote } from "../transport";
import type { HistoryPage, Instance } from "../../types/ipc.generated";
import { loadCachedPage, saveCachedPage } from "./history-page-cache";
import { initialPageSize } from "./event-store-pagination";

/** Chats warmed per pass; history-page-cache keeps 16, so a pass never evicts the user's own opens. */
const MAX_TARGETS = 8;
/** Pause between two prefetches so the tunnel is never saturated by this alone. */
const GAP_MS = 400;

/** Chats worth warming, best first: waiting on an answer, then mid-turn, then newest.
 *  Ended and put-away chats, and any chat already cached, are skipped. */
export function pickPrefetchTargets(
  list: readonly Instance[],
  isCached: (id: string) => boolean,
  max = MAX_TARGETS,
): Instance[] {
  const rank = (i: Instance): number => (i.awaiting ? 0 : i.busy ? 1 : 2);
  return list
    .filter((i) => !i.ended_at && !isCached(i.session_id) && i.kind !== "external")
    .sort((a, b) => rank(a) - rank(b) || (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
    .slice(0, max);
}

let running = false;
/** Tried this page load, so a chat that keeps failing is not retried on every list change. */
const attempted = new Set<string>();

let held = false;
/** A chat open is in flight: a pass stops after its current request so the open has the tunnel to itself. */
export function holdPrefetch(on: boolean): void {
  held = on;
}

/** Warm the cache for `list`. Safe to call on every list change: one pass at a
 *  time, and a pass stops when the page is hidden or a chat open holds it. */
export async function prefetchRecentChats(list: readonly Instance[]): Promise<void> {
  if (!isRemote() || running) return;
  running = true;
  try {
    const targets = pickPrefetchTargets(list, (id) => attempted.has(id) || loadCachedPage(id) !== null);
    for (const t of targets) {
      if (held || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      attempted.add(t.session_id);
      try {
        const args: Record<string, unknown> = { sessionId: t.session_id, messageLimit: initialPageSize() };
        if (t.cwd) args.cwd = String(t.cwd);
        const page = await invoke<HistoryPage>("load_history_page", args, { background: true });
        saveCachedPage(t.session_id, page);
      } catch {
        // A chat with no transcript yet, or a dropped link: the real open fetches it.
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally {
    running = false;
  }
}
