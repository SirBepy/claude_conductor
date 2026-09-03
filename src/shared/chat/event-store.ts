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

import type { ChatEvent, HistoryPage } from "../../types/ipc.generated";
import { invoke } from "../ipc";
import { getTransport } from "../transport";
import { CHAIN_DIVIDER_KIND } from "./chat-classifiers";
import { visibleEventSigs } from "./chat-transcript-sig";
import type { RecentSig } from "./event-store-delivery";
import { DeliveryPolicy } from "./event-store-delivery";
import { EvictionPolicy, touchAccess } from "./event-store-eviction";

type Unlisten = () => void;
type EventListener = (ev: ChatEvent) => void;
/** Fed the authoritative transcript's visible-message sigs after a reconcile. */
type TailListener = (sigs: string[]) => void;

// Page size counts AssistantMessage events only — see read_page in
// src-tauri/src/chat/history.rs. 10 AI replies plus all surrounding
// user/tool/turn events typically renders well under 100 ms.
const INITIAL_PAGE_SIZE = 10;
const OLDER_PAGE_SIZE = 10;

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

/** Boundary row marking where a `/respawn` predecessor's transcript ends. */
function chainDividerEvent(predecessorId: string): ChatEvent {
  return { type: "notification", kind: CHAIN_DIVIDER_KIND, body: predecessorId };
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
   */
  async loadInitial(sessionId: string, cwd?: string, opts?: { force?: boolean }): Promise<ChatEvent[]> {
    let entry = this.cache.get(sessionId);
    if (entry?.initialLoaded && !opts?.force) {
      touchAccess(entry);
      await this.ensureListener(sessionId);
      return entry.events;
    }
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    touchAccess(entry);
    await this.ensureListener(sessionId);
    try {
      const args: { sessionId: string; cwd?: string; messageLimit: number } = {
        sessionId,
        messageLimit: INITIAL_PAGE_SIZE,
      };
      if (cwd) args.cwd = cwd;
      // Snapshot the live events that exist BEFORE fetching the authoritative
      // JSONL page. Everything already buffered is either covered by the page
      // (claude has written it to the transcript) or a synthetic echo we added
      // optimistically (pushSynthetic) - the page is the source of truth for
      // all of it. Keep only events that streamed in DURING/AFTER the fetch,
      // identified by object identity rather than timestamp.
      //
      // Why not timestamp: the live `-p` stream carries no timestamp and JSONL
      // timestamps are ISO strings the parser leaves as 0, so the old
      // timestamp filter compared garbage - the synthetic user message (real
      // Date.now() ms) always passed and got re-appended on top of its JSONL
      // copy, duplicating + reordering messages on chat reload (ai_todo 65).
      const liveBefore = new Set(entry.events);
      const page = await invoke<HistoryPage>("load_history_page", args);
      const liveAfterPage = entry.events.filter((ev) => !liveBefore.has(ev));
      entry.events = [...page.events, ...liveAfterPage];
      entry.oldestSeq = Number(page.oldest_seq);
      entry.pageSessionId = sessionId;
      entry.pageHasMore = page.has_more;
      entry.chainNextId = page.continues_from ?? null;
      entry.hasMore = entry.pageHasMore || entry.chainNextId !== null;
    } catch {
      /* tolerate absence (no JSONL yet for brand-new sessions) */
    }
    entry.initialLoaded = true;
    return entry.events;
  }

  /**
   * Re-read the authoritative JSONL transcript tail and recover any committed
   * message the live channel never delivered. The daemon->app notifier is lossy
   * (drops frames under backpressure - see project_daemon_notifier_broadcast_lossy),
   * so a turn that completed while this session was backgrounded can be absent
   * from the cache even though the sidebar marked it "done" (that status rides a
   * separate, more reliable channel). loadInitial is deliberately idempotent and
   * will NOT refetch once cached, so without this a reopened session shows the
   * stale cache until a manual refresh. This always hits the page and self-heals.
   *
   * Recovered events are appended in transcript order and pushed through the
   * normal subscriber path so an open renderer paints them. Double-render-safe:
   * only events whose content signature is absent from the cache are recovered.
   * A finalized assistant whose text matches a cached streaming partial counts
   * as already present (the partial covers its finalized form). No-op until
   * initialLoaded unless `opts.force`, which delegates to a full `loadInitial`
   * since there is nothing to diff against before the first load.
   */
  async reconcileLatest(sessionId: string, cwd?: string, opts?: { force?: boolean }): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry || !entry.initialLoaded) {
      if (!opts?.force) return;
      await this.loadInitial(sessionId, cwd, { force: true });
      return;
    }
    touchAccess(entry);
    let page: HistoryPage;
    try {
      const args: { sessionId: string; cwd?: string; messageLimit: number } = {
        sessionId,
        messageLimit: INITIAL_PAGE_SIZE,
      };
      if (cwd) args.cwd = cwd;
      page = await invoke<HistoryPage>("load_history_page", args);
    } catch (err) {
      // Shares this path with "no transcript yet", so a brand-new session
      // warns briefly - worth it now the recovery heartbeat depends on it.
      console.warn(`[event-store] reconcileLatest(${sessionId}) failed`, err);
      return;
    }
    const have = new Set<string>();
    for (const ev of entry.events) {
      const s = this.delivery.sigOf(ev);
      if (s !== null) {
        have.add(s);
      } else if (ev.type === "assistant_message") {
        // Streaming partial: its accumulated text covers the finalized form, so
        // a matching page final isn't a fresh drop. The last partial carries the
        // full text, which equals the final's sig.
        const t = this.delivery.contentText(ev);
        if (t !== null) have.add(`a:${t}`);
      }
    }
    const missing = page.events.filter((ev) => {
      const s = this.delivery.sigOf(ev);
      return s !== null && !have.has(s);
    });
    for (const ev of missing) {
      entry.events.push(ev);
      this.delivery.recordSig(entry, ev, "page");
      entry.subscribers.forEach((fn) => {
        try { fn(ev); } catch { /* ignore */ }
      });
    }
    // Fires even when nothing was recovered: the diff above only sees what the
    // CACHE lacks, never what a renderer failed to paint from it.
    const tailSigs = visibleEventSigs(page.events);
    entry.tailWatchers.forEach((fn) => {
      try { fn(tailSigs); } catch { /* ignore */ }
    });
  }

  /** Subscribe to the post-reconcile transcript tail (carries no event). */
  subscribeTranscriptTail(sessionId: string, fn: TailListener): () => void {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    entry.tailWatchers.add(fn);
    return () => { this.cache.get(sessionId)?.tailWatchers.delete(fn); };
  }

  /**
   * Fetch the previous page of older messages and prepend them to the cache.
   * Returns the prepended slice, or null if there is nothing more to load
   * or a load is already in flight.
   *
   * Once this chat's transcript runs out the walk hops to the chat it took over
   * from, injecting a divider and restarting the cursor at that file's EOF.
   */
  async loadOlder(sessionId: string, cwd?: string): Promise<ChatEvent[] | null> {
    const entry = this.cache.get(sessionId);
    if (!entry || !entry.initialLoaded) return null;
    touchAccess(entry);
    if (!entry.hasMore || entry.loadingOlder) return null;
    const hop = !entry.pageHasMore;
    const targetId = hop ? entry.chainNextId : entry.pageSessionId;
    if (!targetId) return null;
    if (!hop && entry.oldestSeq == null) return null;
    entry.loadingOlder = true;
    try {
      const args: { sessionId: string; cwd?: string; beforeSeq?: number; messageLimit: number } = {
        sessionId: targetId,
        messageLimit: OLDER_PAGE_SIZE,
      };
      if (!hop) args.beforeSeq = entry.oldestSeq as number;
      if (cwd) args.cwd = cwd;
      const page = await invoke<HistoryPage>("load_history_page", args);
      if (!page.events.length) {
        entry.hasMore = false;
        entry.chainNextId = null;
        return null;
      }
      // Tag events from a predecessor's file so "Load full output" fetches
      // from that transcript, not the open chat's (todo 861). Not gated on
      // `hop`: pageSessionId is reassigned unconditionally below, so a
      // second loadOlder post-hop would otherwise look like the open chat.
      if (targetId !== sessionId) {
        for (const ev of page.events) (ev as { originSessionId?: string }).originSessionId = targetId;
      }
      // Divider goes AFTER the older events - the array is oldest-first.
      const incoming = hop ? [...page.events, chainDividerEvent(targetId)] : page.events;
      entry.events = [...incoming, ...entry.events];
      entry.oldestSeq = Number(page.oldest_seq);
      entry.pageSessionId = targetId;
      entry.pageHasMore = page.has_more;
      entry.chainNextId = page.continues_from ?? null;
      entry.hasMore = entry.pageHasMore || entry.chainNextId !== null;
      return incoming;
    } catch {
      return null;
    } finally {
      entry.loadingOlder = false;
    }
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
