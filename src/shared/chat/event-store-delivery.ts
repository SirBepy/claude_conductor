// Live-event delivery/dedup, split from event-store.ts's pagination half
// (todo 862), same seam as EvictionPolicy (ai_todo 196) - see that file's
// header/CacheEntry for the shared shape.

import type { ChatEvent } from "../../types/ipc.generated";
import { normalizeUserMessageText } from "./chat-transforms";
import type { CacheEntry } from "./event-store";
import { touchAccess } from "./event-store-eviction";

/** Delivery channel a live/recovered event came through: runner (chat:<id>),
 *  watcher (chat-watch:<id>), synthetic (composer echo), or page (reconcile). */
export type EventSource = "runner" | "watcher" | "synthetic" | "page";

/** The `assistant_delta` member of the ChatEvent union. */
export type AssistantDeltaEvent = Extract<ChatEvent, { type: "assistant_delta" }>;

// Same-content live deliveries within this window from DIFFERENT sources
// (runner vs watcher) are duplicates, not distinct turns - live events carry
// no reliable timestamp. See ai_todo 77.
export const DEDUP_WINDOW_MS = 10_000;

// A cold `claude` took 24.9s to write a submitted prompt into the JSONL, long
// past DEDUP_WINDOW_MS, so echo sigs get their own consume-on-match set (659).
export const ECHO_MATCH_WINDOW_MS = 5 * 60_000;

// Attachment tokens the composer appends as text; stripped from the dedup
// sig only (JSONL stores them as image blocks instead) - see sigOf.
export const FILE_TOKEN_SIG_RE = /<file:[^>]*>/g;

export interface RecentSig {
  /** Dedup key: type + content/id. */
  sig: string;
  /** Text of a finalized assistant message; suppresses a runner partial
   * whose text is a prefix of it. Null for non-assistant events. */
  text: string | null;
  /** True when this was a finalized (non-streaming) assistant message. */
  assistantFinal: boolean;
  ts: number;
  /** Source this recording came from - a matching sig is only a duplicate
   * across DIFFERENT sources (see isLiveDuplicate); same-source repeats survive. */
  source: EventSource;
}

/** Owns live-event delivery/dedup for a session cache, composed the same
 * way EvictionPolicy is (needs a reconcileLatest callback for events_lagged). */
export class DeliveryPolicy {
  /** Routes rate-limit rejections to the global banner instead of the transcript. */
  private rateLimitHandler: ((sessionId: string, body: string) => void) | null = null;

  constructor(
    private cache: Map<string, CacheEntry>,
    private reconcileLatest: (sessionId: string) => void,
  ) {}

  /** Register the global rate-limit-rejection sink (the banner controller). */
  setRateLimitHandler(fn: (sessionId: string, body: string) => void): void {
    this.rateLimitHandler = fn;
  }

  /** Live-source delivery gate (runner/watcher/synthetic): drops cross-
   * source duplicates, then pushes/notifies. */
  deliver(sessionId: string, ev: ChatEvent, source: EventSource): boolean {
    // Route rate-limit rejections to the banner before dedup, for any attached session.
    if (ev.type === "notification" && (ev as { kind?: string }).kind === "rate_limit") {
      this.rateLimitHandler?.(sessionId, (ev as { body: string }).body);
      return false;
    }
    // Dropped non-delta events: force a transcript read, never render as a bubble.
    if (ev.type === "events_lagged") {
      this.reconcileLatest(sessionId);
      return false;
    }
    const entry = this.cache.get(sessionId);
    if (!entry) return false;
    // O(delta) chunks rebuild the running text here (ai_todo 186).
    if (ev.type === "assistant_delta") {
      this.applyDelta(entry, ev);
      return false;
    }
    // Turn boundary: streamAcc's numbering resets next turn, so drop it here.
    // An interrupted turn's final text never matches streamAcc (see
    // noiseAssistantLabel), so record streamAcc's text as an already-delivered
    // final now - the watcher's later JSONL replay then dedups against it.
    if (ev.type === "turn_usage" || (ev.type === "assistant_message" && !ev.streaming)) {
      if (entry.streamAcc && entry.streamAcc.text) {
        entry.recent.push({
          sig: `a:${entry.streamAcc.text}`,
          text: entry.streamAcc.text,
          assistantFinal: true,
          ts: Date.now(),
          source,
        });
      }
      entry.streamAcc = null;
    }
    if (this.isLiveDuplicate(entry, ev, source)) return false;
    this.recordSig(entry, ev, source);
    entry.events.push(ev);
    // Any accepted event refreshes lastAccess so a mid-turn session never idles out.
    touchAccess(entry);
    entry.subscribers.forEach((fn) => {
      try { fn(ev); } catch { /* ignore */ }
    });
    return true;
  }

  /** Folds one `assistant_delta` into the accumulator, synthesizing an
   * `assistant_message{streaming:true}` with the full accumulated text so
   * downstream consumers see the pre-delta shape. Mirrors the daemon pump's
   * `StreamingText` seq/block/snapshot restart rules. */
  private applyDelta(entry: CacheEntry, ev: AssistantDeltaEvent): void {
    const block = Number(ev.block);
    const seq = Number(ev.seq);
    const acc = entry.streamAcc;
    const blockChanged = !!acc && block !== acc.block;
    // A block change restarts the accumulator; finalize the OLD synth first (todo 693).
    if (blockChanged && acc!.evRef) this.finalizeStreamRef(entry, acc!.evRef);
    const nextRef = blockChanged ? null : (acc?.evRef ?? null);
    if (ev.snapshot) {
      if (acc && block === acc.block && seq <= acc.seq) return; // stale resync
      entry.streamAcc = { block, seq, text: ev.text, evRef: nextRef };
    } else if (!acc || blockChanged || seq === 1) {
      entry.streamAcc = { block, seq, text: ev.text, evRef: nextRef };
    } else if (seq <= acc.seq) {
      return; // already covered by a snapshot resync
    } else {
      acc.text += ev.text;
      acc.seq = seq;
    }
    const cur = entry.streamAcc!;
    const synth = {
      type: "assistant_message",
      content: [{ type: "text", text: cur.text }],
      streaming: true,
      timestamp: Number(ev.timestamp),
    } as unknown as ChatEvent;
    // Suppress if a finalized assistant already covers this text (watcher won);
    // deltas only arrive on the runner channel.
    if (this.isLiveDuplicate(entry, synth, "runner")) return;
    const last = entry.events[entry.events.length - 1];
    if (cur.evRef && last === cur.evRef) {
      entry.events[entry.events.length - 1] = synth;
    } else {
      entry.events.push(synth);
    }
    cur.evRef = synth;
    touchAccess(entry);
    entry.subscribers.forEach((fn) => {
      try { fn(synth); } catch { /* ignore */ }
    });
  }

  /** Marks a superseded block's synthesized event done (cache + subscribers);
   *  no-op if `ref` already left `entry.events` (see `applyDelta`). */
  private finalizeStreamRef(entry: CacheEntry, ref: ChatEvent): void {
    const idx = entry.events.lastIndexOf(ref);
    if (idx === -1) return;
    const finalized = { ...ref, streaming: false } as ChatEvent;
    entry.events[idx] = finalized;
    entry.subscribers.forEach((fn) => {
      try { fn(finalized); } catch { /* ignore */ }
    });
  }

  /** Concatenated text of an assistant/user message, else null. Also used
   * by reconcileLatest (pagination half) to diff against page content. */
  contentText(ev: ChatEvent): string | null {
    if (ev.type !== "assistant_message" && ev.type !== "user_message") return null;
    const blocks = (ev as { content?: { type: string; text?: string }[] }).content ?? [];
    return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  }

  /** Dedup sig, or null for events never deduped (streaming partials, etc).
   * Also used by reconcileLatest (pagination half) to diff a page. */
  sigOf(ev: ChatEvent): string | null {
    switch (ev.type) {
      case "assistant_message":
        // Streaming partials mutate every chunk; dedup only the finalized form.
        return ev.streaming ? null : `a:${this.contentText(ev)}`;
      case "user_message": {
        // Normalize (JSONL scaffolding vs raw synthetic text) and strip
        // <file:path::name> attachment tokens - the JSONL stores those as image
        // blocks, so raw text differs by exactly those tokens; sig-only, doesn't
        // affect the rendered text.
        const raw = this.contentText(ev) ?? "";
        const sig = normalizeUserMessageText(raw).replace(FILE_TOKEN_SIG_RE, "").trim();
        return `u:${sig}`;
      }
      case "tool_use":
        return `tu:${ev.id}`;
      case "tool_result":
        return `tr:${ev.tool_use_id}`;
      case "notification":
        return `n:${ev.body}`;
      default:
        return null;
    }
  }

  private isLiveDuplicate(entry: CacheEntry, ev: ChatEvent, source: EventSource): boolean {
    const now = Date.now();
    entry.recent = entry.recent.filter((r) => now - r.ts < DEDUP_WINDOW_MS);
    // Suppress a runner partial whose text is a prefix of an already-delivered final (watcher won).
    if (ev.type === "assistant_message" && ev.streaming) {
      const t = this.contentText(ev);
      if (t === null) return false;
      return entry.recent.some((r) => r.assistantFinal && r.text !== null && r.text.startsWith(t));
    }
    const sig = this.sigOf(ev);
    if (sig === null) return false;
    // Cross-source only: same-channel repeats are distinct events, not races.
    if (entry.recent.some((r) => r.sig === sig && r.source !== source)) return true;
    if (ev.type !== "user_message") return false;
    // The watcher's replay of an already-echoed turn, past DEDUP_WINDOW_MS.
    entry.pendingEchoes = entry.pendingEchoes.filter((e) => now - e.ts < ECHO_MATCH_WINDOW_MS);
    const idx = entry.pendingEchoes.findIndex((e) => e.sig === sig);
    if (idx === -1) return false;
    entry.pendingEchoes.splice(idx, 1);
    return true;
  }

  /** Records a sig; also called by reconcileLatest (pagination half) for
   * page-sourced recovery, so later live delivery dedups against it. */
  recordSig(entry: CacheEntry, ev: ChatEvent, source: EventSource): void {
    const sig = this.sigOf(ev);
    if (sig === null) return;
    entry.recent.push({
      sig,
      text: ev.type === "assistant_message" ? this.contentText(ev) : null,
      assistantFinal: ev.type === "assistant_message" && !ev.streaming,
      ts: Date.now(),
      source,
    });
  }
}
