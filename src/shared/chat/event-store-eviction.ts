// Idle-eviction / TTL lifecycle policy for the session event cache. Split out
// from event-store.ts's core dedup/cache job (ai_todo 196) - the perf pass
// that introduced this (2026-07-09, commits c208e471/a3065785) layered a
// distinct concern onto the store, so it now composes an EvictionPolicy
// instance instead of owning the timer/teardown logic itself. See
// event-store.ts's file header and CacheEntry for the full entry shape and
// the "why" behind lastAccess/ended semantics.

import type { CacheEntry } from "./event-store";
import { visibleInterval } from "../visible-interval";

// Eviction (ai_todo perf fix): a session ever opened stays cached forever
// (see event-store.ts's file header) unless reclaimed. An entry is eligible
// once it has both (a) no subscribers - nothing is currently rendering it in
// a pane, on this window/webview - and (b) gone idle for IDLE_TTL_MS. "Idle"
// is driven by lastAccess, which every genuine read/render touches AND every
// accepted live event (deliver()) refreshes - so a background session with an
// active turn (tool calls, streaming chunks, anything) keeps pushing
// lastAccess forward and never goes idle long enough to be swept mid-turn.
// Reopening after eviction is safe: loadInitial/subscribe rebuild a fresh
// entry and re-fetch from disk via load_history_page, same as a session
// touched for the first time.
export const IDLE_TTL_MS = 30 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;

/** Stamps an entry's `lastAccess` to now. The single touch point every
 * genuine read/render/live-event call routes through, so the idle clock the
 * sweep checks always reflects the latest real activity. */
export function touchAccess(entry: CacheEntry): void {
  entry.lastAccess = Date.now();
}

/** Owns the idle-eviction/TTL lifecycle for a session cache. Composed by
 * SessionEventStore (`this.eviction = new EvictionPolicy(this.cache)`) rather
 * than subclassed, since the eviction policy only ever needs the shared cache
 * map and never the store's pagination/dedup state. */
export class EvictionPolicy {
  constructor(private cache: Map<string, CacheEntry>) {}

  /** Starts the module-level sweep timer (every SWEEP_INTERVAL_MS). Pure
   * in-memory scan, no IPC - a hidden window has nothing on screen for it to
   * refresh, so it pauses like the rest of the PAUSE-WHEN-HIDDEN pollers
   * (todo 1008) and flushes once on return.
   *
   * SessionEventStore is constructed in plenty of non-jsdom Node test
   * environments (and DOM-shim suites with a partial `document`) that have no
   * real `document.addEventListener` - visibleInterval needs one, so fall
   * back to the original bare interval + best-effort unref there. The real
   * Tauri webview always has a full `document`. */
  startSweepTimer(): void {
    const hasDom = typeof document !== "undefined" && typeof document.addEventListener === "function";
    if (!hasDom) {
      const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      const maybeUnref = (timer as unknown as { unref?: () => void })?.unref;
      if (typeof maybeUnref === "function") maybeUnref.call(timer);
      return;
    }
    visibleInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  /** Full teardown: stop both live listeners (runner + file-watcher) and drop
   * the entry entirely. The single choke point every eviction path routes
   * through, so a session that gets re-touched later goes through the normal
   * "no entry yet" cold path (loadInitial/subscribe rebuild it and re-fetch
   * from disk) rather than resurrecting stale state. */
  teardown(sessionId: string, entry: CacheEntry): void {
    if (entry.unlisten) {
      try { entry.unlisten(); } catch { /* ignore */ }
    }
    if (entry.unlistenWatch) {
      try { entry.unlistenWatch(); } catch { /* ignore */ }
    }
    this.cache.delete(sessionId);
  }

  /**
   * Mark a session as ended (its `ended_at` is now set) and evict it if
   * nothing is currently viewing it. Called from the sessions/detached-window
   * "instances-changed" handlers for any id that just dropped out of the live
   * registry - see sidebar.ts's `isLive`. Idempotent and safe to call for a
   * session that isn't cached (no-op) or was never opened.
   *
   * If the session IS currently open in a pane (subscribers present), eviction
   * is deferred: `ended` is recorded so `subscribe()`'s returned unsubscribe
   * finishes the teardown the moment the pane stops viewing it, instead of
   * blanking a transcript the user is looking at.
   */
  evictEnded(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    entry.ended = true;
    if (entry.subscribers.size === 0) this.teardown(sessionId, entry);
  }

  /**
   * Inverse of {@link evictEnded}'s deferred branch: a fresh successful
   * instance list shows this session alive again, so clear the `ended` latch.
   * Without this, a session that transiently vanished from the registry while
   * it was the viewed pane (e.g. a daemon restart briefly empties the list -
   * a SUCCESSFUL fetch, see setActiveSession's doc in sessions/state.ts) would
   * keep `ended: true` forever, and closing the pane later would wrongly tear
   * down a live session's cache and listeners. No-op when not cached.
   */
  unmarkEnded(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (entry) entry.ended = false;
  }

  /** Module-level TTL sweep (every SWEEP_INTERVAL_MS): reclaims entries that
   * are both unviewed (no subscribers) and idle past IDLE_TTL_MS. Skips
   * anything with a subscriber (visible in some pane right now) regardless of
   * how stale lastAccess looks. */
  sweep(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.cache) {
      if (entry.subscribers.size > 0) continue;
      if (now - entry.lastAccess < IDLE_TTL_MS) continue;
      this.teardown(sessionId, entry);
    }
  }
}
