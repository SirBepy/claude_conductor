// Pagination / chain-hop half of event-store.ts's session cache (todo 862's
// follow-up note - the delivery half was already split into
// event-store-delivery.ts; this is the other cohesive unit named there),
// same composition shape as EvictionPolicy (ai_todo 196) and DeliveryPolicy
// (todo 862) - see event-store.ts's file header and CacheEntry for the
// shared shape.

import type { ChatEvent, HistoryPage } from "../../types/ipc.generated";
import { invoke } from "../ipc";
import { CHAIN_DIVIDER_KIND } from "./chat-classifiers";
import { visibleEventSigs } from "./chat-transcript-sig";
import type { CacheEntry, TailListener } from "./event-store";
import { touchAccess } from "./event-store-eviction";
import type { DeliveryPolicy } from "./event-store-delivery";

// Page size counts AssistantMessage events only - see read_page in
// src-tauri/src/chat/history.rs. 10 AI replies plus all surrounding
// user/tool/turn events typically renders well under 100 ms.
const INITIAL_PAGE_SIZE = 10;
const OLDER_PAGE_SIZE = 10;

/** Boundary row marking where a `/respawn` predecessor's transcript ends. */
function chainDividerEvent(predecessorId: string): ChatEvent {
  return { type: "notification", kind: CHAIN_DIVIDER_KIND, body: predecessorId };
}

/** Owns pagination/chain-walk for a session cache, composed the same way
 * EvictionPolicy/DeliveryPolicy are. Injected with an `ensureListener`
 * callback (loadInitial must arm the live listener before/while fetching the
 * page) and a `makeEntry` callback (loadInitial/subscribeTranscriptTail can
 * both be the first touch of a session) rather than owning either itself. */
export class PaginationPolicy {
  constructor(
    private cache: Map<string, CacheEntry>,
    private delivery: DeliveryPolicy,
    private ensureListener: (sessionId: string) => Promise<void>,
    private makeEntry: () => CacheEntry,
  ) {}

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
}
