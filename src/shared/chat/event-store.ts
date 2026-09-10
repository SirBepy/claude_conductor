// Per-session event store. Caches paginated ChatEvents per session_id and
// maintains a single Tauri `chat:<id>` listener for any session that has been
// touched, so:
//
// - reopening a session is instant (cache hit, no IPC, no JSONL re-parse)
// - detached/unselected sessions keep accumulating live events in the
//   background so the user does not miss messages when they come back
// - multiple consumers (sidebar pane + detached window) share one upstream
//   listener instead of each opening their own
//
// Pagination: chat-open path uses `loadInitial` (last 20 messages) and
// `loadOlder` (next 20 older), backed by the `load_history_page` IPC. The
// History view (read-only browse) still uses `load_history` directly.

import type { ChatEvent } from "../../types/ipc.generated";
import { getTransport } from "../transport";
import type { RecentSig } from "./event-store-delivery";
import { DeliveryPolicy } from "./event-store-delivery";
import { EvictionPolicy, touchAccess } from "./event-store-eviction";
import { PaginationPolicy } from "./event-store-pagination";

type Unlisten = () => void;
type EventListener = (ev: ChatEvent) => void;
/** Fed the authoritative transcript's visible-message sigs after a reconcile. */
export type TailListener = (sigs: string[]) => void;

export interface CacheEntry {
  events: ChatEvent[];
  oldestSeq: number | null;
  /** More to load from ANYWHERE - this file, or a predecessor above it. */
  hasMore: boolean;
  /** Transcript `oldestSeq` points into; a predecessor's id after a chain hop.
   *  Byte offsets are per-file, so the cursor is meaningless without it. */
  pageSessionId: string | null;
  pageHasMore: boolean;
  /** The chat `pageSessionId` took over from. Null at the end of the walk. */
  chainNextId: string | null;
  loadingOlder: boolean;
  initialLoaded: boolean;
  unlisten: Unlisten | null;
  unlistenWatch: Unlisten | null;
  /** In-flight runner-channel registration - concurrent callers share it. */
  listenerInit: Promise<void> | null;
  /** Same race guard as `listenerInit`, for the watcher channel. */
  watchListenerInit: Promise<void> | null;
  subscribers: Set<EventListener>;
  /** Post-reconcile "what should be on screen", for renderer staleness. */
  tailWatchers: Set<TailListener>;
  /** Recently-delivered live event signatures, for cross-source dedup. */
  recent: RecentSig[];
  /** Composer echoes awaiting their JSONL replay; matched once, then removed. */
  pendingEchoes: { sig: string; ts: number }[];
  /** Wall-clock ms of the last genuine access (load/read/subscribe) or
   * accepted live event, touched via touchAccess(). Drives the TTL sweep -
   * see event-store-eviction.ts's IDLE_TTL_MS (ai_todo 196). */
  lastAccess: number;
  /** True once an `instances-changed` snapshot reported this session's
   * `ended_at` set. An ended session will never produce another event, so
   * once it also has no subscribers it is torn down immediately rather than
   * waiting out the TTL. */
  ended: boolean;
  /** Live `assistant_delta` accumulator (ai_todo 186). The wire now carries
   * O(delta) text chunks; this rebuilds the running block text and tracks the
   * synthesized streaming event most recently pushed for it, so successive
   * deltas REPLACE one cache entry instead of appending one per flush. Null
   * until the first delta of a turn; reset at turn end. */
  streamAcc: { block: number; seq: number; text: string; evRef: ChatEvent | null } | null;
}

class SessionEventStore {
  private cache = new Map<string, CacheEntry>();
  /** Idle-eviction/TTL lifecycle policy, extracted from this store (ai_todo
   * 196) - see event-store-eviction.ts. Composed over the same cache map so
   * teardown/evictEnded/unmarkEnded/sweep all see the store's live entries. */
  private eviction = new EvictionPolicy(this.cache);
  /** Live-delivery/dedup policy, extracted from this store (todo 862) - see
   * event-store-delivery.ts. Composed over the same cache map; injected with
   * a reconcileLatest callback since the delivery half needs it for
   * events_lagged recovery but must not own the pagination logic itself. */
  private delivery = new DeliveryPolicy(this.cache, (sessionId) => {
    void this.reconcileLatest(sessionId, undefined, { force: true });
  });
  /** Pagination/chain-walk policy, extracted from this store (todo 862's
   * follow-up) - see event-store-pagination.ts. Composed over the same cache
   * map; injected with ensureListener (loadInitial must arm the live
   * listener) and makeEntry (either method can be a session's first touch),
   * following the same composition shape as delivery above. */
  private pagination = new PaginationPolicy(
    this.cache,
    this.delivery,
    (sessionId) => this.ensureListener(sessionId),
    () => this.makeEntry(),
  );

  constructor() {
    this.eviction.startSweepTimer();
  }

  /** Register the global rate-limit-rejection sink (the banner controller). */
  setRateLimitHandler(fn: (sessionId: string, body: string) => void): void {
    this.delivery.setRateLimitHandler(fn);
  }

  events(sessionId: string): ChatEvent[] {
    const entry = this.cache.get(sessionId);
    if (entry) touchAccess(entry);
    return entry?.events.slice() ?? [];
  }

  isLoaded(sessionId: string): boolean {
    return !!this.cache.get(sessionId)?.initialLoaded;
  }

  /** Cached session ids, most-recently-accessed first. */
  cachedSessionIdsByRecency(): string[] {
    return [...this.cache.entries()]
      .sort((a, b) => b[1].lastAccess - a[1].lastAccess)
      .map(([id]) => id);
  }

  hasMore(sessionId: string): boolean {
    return !!this.cache.get(sessionId)?.hasMore;
  }

  /**
   * Fetch the last `INITIAL_PAGE_SIZE` messages for `sessionId` and attach
   * the live listener. Idempotent: subsequent calls return the cached array
   * without re-fetching. Returns the live (mutable internal) event array.
   * Delegates to PaginationPolicy (event-store-pagination.ts, todo 862).
   */
  loadInitial(sessionId: string, cwd?: string, opts?: { force?: boolean }): Promise<ChatEvent[]> {
    // Not `async`/`return await`: an async wrapper adds an extra microtask
    // tick over calling the delegate directly (its `return` goes through
    // promise-resolution instead of just handing the same promise back),
    // and tests/chat-renderer-streaming.test.mjs counts ticks exactly.
    return this.pagination.loadInitial(sessionId, cwd, opts);
  }

  /**
   * Re-read the authoritative JSONL transcript tail and recover any committed
   * message the live channel never delivered - see event-store-pagination.ts
   * (todo 862) for the full rationale; delegates there.
   */
  reconcileLatest(sessionId: string, cwd?: string, opts?: { force?: boolean }): Promise<void> {
    return this.pagination.reconcileLatest(sessionId, cwd, opts);
  }

  /** Subscribe to the post-reconcile transcript tail (carries no event).
   *  Delegates to PaginationPolicy (event-store-pagination.ts, todo 862). */
  subscribeTranscriptTail(sessionId: string, fn: TailListener): () => void {
    return this.pagination.subscribeTranscriptTail(sessionId, fn);
  }

  /**
   * Fetch the previous page of older messages and prepend them to the cache.
   * Returns the prepended slice, or null if there is nothing more to load
   * or a load is already in flight. Delegates to PaginationPolicy
   * (event-store-pagination.ts, todo 862).
   */
  loadOlder(sessionId: string, cwd?: string): Promise<ChatEvent[] | null> {
    return this.pagination.loadOlder(sessionId, cwd);
  }

  subscribe(sessionId: string, fn: EventListener): () => void {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    entry.subscribers.add(fn);
    touchAccess(entry);
    void this.ensureListener(sessionId);
    return () => {
      const e = this.cache.get(sessionId);
      if (!e) return;
      e.subscribers.delete(fn);
      if (e.subscribers.size === 0) {
        touchAccess(e);
        // The session already ended while we were the last viewer - it will
        // never produce another event, so tear down now instead of waiting
        // out the TTL (see evictEnded).
        if (e.ended) this.eviction.teardown(sessionId, e);
      }
    };
  }

  async swap(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const fromEntry = this.cache.get(fromId);
    if (!fromEntry) return;
    const existing = this.cache.get(toId);
    if (existing) {
      // Merge: fromEntry's data folds into `existing` and fromEntry itself is
      // discarded, so both its live listeners must be retired here or the
      // losing entry's chat-watch listener (ai_todo 189) leaks forever - the
      // rename branch below skips this because fromEntry survives as toId's
      // entry and keeps its unlistenWatch alive.
      for (const ev of fromEntry.events) existing.events.push(ev);
      for (const sub of fromEntry.subscribers) existing.subscribers.add(sub);
      for (const w of fromEntry.tailWatchers) existing.tailWatchers.add(w);
      for (const r of fromEntry.recent) existing.recent.push(r);
      // A new chat echoes into the placeholder entry, so unmatched echoes have
      // to survive the upgrade to the real session id.
      for (const e of fromEntry.pendingEchoes) existing.pendingEchoes.push(e);
      existing.initialLoaded = existing.initialLoaded || fromEntry.initialLoaded;
      existing.oldestSeq = existing.oldestSeq ?? fromEntry.oldestSeq;
      existing.hasMore = existing.hasMore && fromEntry.hasMore;
      this.eviction.teardown(fromId, fromEntry);
    } else {
      // Plain rename: fromEntry itself becomes toId's entry, so only retire
      // the runner listener bound to the old `chat:<fromId>` channel name;
      // unlistenWatch is left untouched and carries over with the entry.
      if (fromEntry.unlisten) {
        try { fromEntry.unlisten(); } catch { /* ignore */ }
        fromEntry.unlisten = null;
      }
      this.cache.delete(fromId);
      this.cache.set(toId, fromEntry);
    }
    await this.ensureListener(toId);
  }

  bust(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    entry.events = [];
    entry.oldestSeq = null;
    entry.hasMore = false;
    entry.initialLoaded = false;
    entry.recent = [];
    entry.pendingEchoes = [];
    entry.streamAcc = null;
  }

  pushSynthetic(sessionId: string, ev: ChatEvent): void {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    if (!this.delivery.deliver(sessionId, ev, "synthetic") || ev.type !== "user_message") return;
    // A tool-result-only user line normalizes to "u:" too; never tokenize it.
    const sig = this.delivery.sigOf(ev);
    if (sig === null || sig === "u:") return;
    entry.pendingEchoes.push({ sig, ts: Date.now() });
  }

  /** Roll back a previously `pushSynthetic`-ed event (matched by reference
   *  identity) after its send actually failed - e.g. active-session.ts's
   *  optimistic user bubble, which must not linger looking sent once
   *  `invoke("send_message")` rejects. No-op if the event isn't found (already
   *  superseded by a real reconcile). Does not re-render by itself; callers
   *  with an attached renderer for this session should follow up with
   *  `renderer.loadFromStore()` to repaint without the reverted bubble. */
  removeSynthetic(sessionId: string, ev: ChatEvent): void {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    const idx = entry.events.indexOf(ev);
    if (idx !== -1) entry.events.splice(idx, 1);
    const sig = this.delivery.sigOf(ev);
    const tok = sig === null ? -1 : entry.pendingEchoes.findIndex((e) => e.sig === sig);
    if (tok !== -1) entry.pendingEchoes.splice(tok, 1);
  }

  private makeEntry(): CacheEntry {
    return {
      events: [],
      oldestSeq: null,
      hasMore: false,
      pageSessionId: null,
      pageHasMore: false,
      chainNextId: null,
      loadingOlder: false,
      initialLoaded: false,
      unlisten: null,
      unlistenWatch: null,
      listenerInit: null,
      watchListenerInit: null,
      subscribers: new Set(),
      tailWatchers: new Set(),
      recent: [],
      pendingEchoes: [],
      lastAccess: Date.now(),
      ended: false,
      streamAcc: null,
    };
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
   * blanking a transcript the user is looking at. Delegates to the
   * EvictionPolicy companion module (ai_todo 196).
   */
  evictEnded(sessionId: string): void {
    this.eviction.evictEnded(sessionId);
  }

  /**
   * Inverse of {@link evictEnded}'s deferred branch: a fresh successful
   * instance list shows this session alive again, so clear the `ended` latch.
   * Without this, a session that transiently vanished from the registry while
   * it was the viewed pane (e.g. a daemon restart briefly empties the list -
   * a SUCCESSFUL fetch, see setActiveSession's doc in sessions/state.ts) would
   * keep `ended: true` forever, and closing the pane later would wrongly tear
   * down a live session's cache and listeners. No-op when not cached.
   * Delegates to the EvictionPolicy companion module (ai_todo 196).
   */
  unmarkEnded(sessionId: string): void {
    this.eviction.unmarkEnded(sessionId);
  }

  private async ensureListener(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry || entry.unlisten) return;
    // subscribe()'s fire-and-forget call and loadInitial()'s awaited one can
    // both reach here before either sets entry.unlisten - share one in-flight call.
    if (entry.listenerInit) { await entry.listenerInit; return; }
    entry.listenerInit = (async () => {
      entry.unlisten = await getTransport().listen<ChatEvent>(`chat:${sessionId}`, (payload) => {
        const cur = this.cache.get(sessionId);
        if (!cur) return;
        // claude -p --resume replays history incl. past user messages
        // (remote_echo: false) - drop those; daemon echoes carry remote_echo: true.
        if (payload.type === "user_message" && !(payload as { remote_echo?: boolean }).remote_echo) return;
        this.delivery.deliver(sessionId, payload, "runner");
      });
    })();
    try {
      await entry.listenerInit;
    } finally {
      entry.listenerInit = null;
    }
  }

  /** Recovery for a channel that died silently: ensureListener's guard never
   *  re-arms once set, so unlisten first to force a rebuild. Heartbeat-only,
   *  so ensureListener's other callers keep their cheap no-op path. */
  async reviveListener(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    if (entry.unlisten) {
      try { entry.unlisten(); } catch { /* ignore */ }
      entry.unlisten = null;
    }
    await this.ensureListener(sessionId);
  }

  // Subscribes to chat-watch:<id> events emitted by the JSONL file watcher.
  // Unlike the runner channel, user_messages are allowed through (they come
  // from terminal input, not from claude -p re-emission). Cross-source dedup
  // (against events the runner already pushed for app-driven turns) is handled
  // by `deliver`, keyed on content within a short window - the old
  // timestamp+type key collided because live `-p` events all carry ts=0 and
  // only deduped one direction, so a watcher event that won the race against
  // the runner doubled the turn (ai_todo 77).
  async ensureWatchListener(sessionId: string): Promise<void> {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    if (entry.unlistenWatch) return;
    if (entry.watchListenerInit) { await entry.watchListenerInit; return; }
    entry.watchListenerInit = (async () => {
      entry.unlistenWatch = await getTransport().listen<ChatEvent>(`chat-watch:${sessionId}`, (payload) => {
        this.delivery.deliver(sessionId, payload, "watcher");
      });
    })();
    try {
      await entry.watchListenerInit;
    } finally {
      entry.watchListenerInit = null;
    }
  }

  stopWatchListener(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (!entry?.unlistenWatch) return;
    try { entry.unlistenWatch(); } catch { /* ignore */ }
    entry.unlistenWatch = null;
  }
}

export const sessionEvents = new SessionEventStore();
