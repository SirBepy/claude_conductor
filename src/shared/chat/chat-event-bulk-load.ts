// History bulk replay for ChatRenderer (ai_todo 123, split further per ai_todo
// 314). Chunked with setTimeout yields, calling handleChatEvent per event
// with { silent: true, skipScroll: true } and doing its own before/after
// bookkeeping (reset renderer state, reveal-hold, final settle pass). Split
// out of chat-event-handler.ts, which owns the per-event live dispatch state
// machine this calls into; behavior is byte-identical to the pre-split code.

import type { ChatEvent } from "../../types/ipc.generated";
import {
  flushRender,
  scrollToBottom,
  beginRevealHold,
  scrollToBottomWhenSettled,
} from "./chat-dom-renderer";
import { activeTurnTsSpan, foldLeadingPartialTurn } from "./chat-turn-fold";
import { handleChatEvent } from "./chat-event-handler";
import { applySkipMarks } from "./chat-question-card";
import { perfPhase } from "../perf";
import type { ChatRenderer } from "./chat-renderer";

export interface BulkLoadOpts {
  /** True for a still-live session (resumes ticking on reload); false
   *  (default) for read-only History, where nothing streams in again. */
  resumeLiveTicking?: boolean;
}

/** Lets input and paint through between chunks. `scheduler.yield()` resumes
 *  ahead of other queued tasks, so a busy main thread (other chats streaming,
 *  sidebar renders) can't push the open behind all of its work the way a
 *  setTimeout(0) at the back of the task queue can. Measured in the rig on a
 *  201-event page with back-to-back 200ms competing tasks: 1.6s with
 *  setTimeout(0), 0.9s with scheduler.yield (2026-10-29). WKWebView (macOS)
 *  has no scheduler API, hence the fallback. */
function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === "function") return sched.yield();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function bulkLoadEvents(r: ChatRenderer, events: ChatEvent[], opts: BulkLoadOpts = {}): Promise<void> {
  const myGen = ++r._bulkGen;
  r.liveBuffer = [];
  r.messages = [];
  r.messageEls = [];
  r.dirtyIndices.clear();
  r.streamingIndex = null;
  r.auqPendingResult = false;
  r.auqPreContent = null;
  r.fileEdits = [];
  r.lastActivity = null;
  r.activityIdle = false;
  r.activityToolCanon = null;
  r.activeToolGroups.clear();
  r.activeTurnStart = null;
  r.activeTurnFoldStart = null;
  r.compactionCount = 0;
  r.resetActiveTurnMeta();
  r.prevTurnChipKey = null;
  r.turnFooters.clear();
  r.closeTurnQueue = [];
  r.paginator.resetTurnCarry();
  r.tallyState.reset();
  r.onFileEditsChanged?.([]);
  r.onToolTally?.(r.tallyState.build());
  r.onActivityUpdate?.(null);
  r.container.innerHTML = "";
  // Replay history with the per-event header/thinking-bar callbacks gated; the
  // accumulated final state is fired once below (after the chunk loop).
  r.hydrating = true;
  // Hold the transcript hidden while it assembles. The build is visibly ugly
  // - rows paint top-down, fold into chips, the view snaps to the bottom, and
  // shiki recolors code - all in ~100ms. We reveal the finished frame in one
  // fade once the settle pass has folded, pinned, and highlighted it.
  beginRevealHold(r);
  let slowestChunkMs = 0;
  // Time spent parked in yields, apart from render work: a slow load with a
  // large share here means other main-thread work (or timer throttling)
  // starved it, not that the events were expensive to build.
  let yieldWaitMs = 0;
  let yields = 0;
  const donePhase = perfPhase(
    "bulk-load",
    () => `(${events.length} events, slowest chunk ${Math.round(slowestChunkMs)}ms, ${yields} yields waited ${Math.round(yieldWaitMs)}ms)`,
  );
  const CHUNK = 8;
  // Yield only once this much work has run since the last yield, not after
  // every chunk: a nested setTimeout(0) clamps to 4ms, so yielding per 8
  // events idled ~430ms of an 851-event open (measured 1.2s total).
  const YIELD_BUDGET_MS = 16;
  let sinceYield = performance.now();
  for (let i = 0; i < events.length; i += CHUNK) {
    // A superseding call already re-owns liveBuffer/hydrating from its own
    // line 29/53 - clearing them here would clobber ITS in-flight state
    // (only bulkLoadEvents bumps _bulkGen, so a mismatch always means one).
    if (r._bulkGen !== myGen) { donePhase(); return; }
    const chunkStart = performance.now();
    for (let j = i; j < Math.min(i + CHUNK, events.length); j++) {
      handleChatEvent(r, events[j]!, { silent: true, skipScroll: true });
    }
    flushRender(r);
    slowestChunkMs = Math.max(slowestChunkMs, performance.now() - chunkStart);
    if (i + CHUNK < events.length && performance.now() - sinceYield >= YIELD_BUDGET_MS) {
      const parked = performance.now();
      await yieldToMain();
      sinceYield = performance.now();
      yieldWaitMs += sinceYield - parked;
      yields++;
    }
  }
  donePhase();
  if (r._bulkGen !== myGen) { return; } // see the identical guard above
  // Fold durable skip marks (todo 661) now that every real event has replayed
  // - the older-page fold's counterpart for the initial hydrate.
  applySkipMarks(r, r.paginator.skipMarks);
  flushRender(r);
  // History replay is done: deliver the FINAL header badge + thinking-bar
  // state in ONE shot (per-event updates were gated above so the badge didn't
  // count up and the bar didn't flip through every past activity). A done turn
  // leaves lastActivity null -> the bar clears; a still-busy turn shows its
  // last activity, and buffered live events below take over from there.
  r.hydrating = false;
  r.onFileEditsChanged?.(r.getFileEdits());
  r.onActivityUpdate?.(r.lastActivity, r.activityIdle);
  r.onToolTally?.(r.tallyState.build());
  // Same guard as wireRenderer: a replay with no usage or model line would
  // push zeros over the statusbar's cached chips.
  const meta = r.getMeta();
  if (meta.hasUsage || meta.model) r.onMetaUpdate?.(meta);
  // The final turn never gets a closing user_message: a live session resumes
  // ticking; History settles frozen (nothing left to stream in, ever).
  if (r.activeTurnChipKey !== null && r.activeTurnUsage) {
    const u = r.activeTurnUsage;
    const totals = { ...u, durationMs: u.durationMs > 0 ? u.durationMs : activeTurnTsSpan(r) };
    if (opts.resumeLiveTicking) {
      r.turnFooters.primeReplayedLiveRow(r.activeTurnChipKey, r.activeTurnStartedAtMs || Date.now(), totals);
    } else {
      r.turnFooters.settleMetaRow(r.activeTurnChipKey, totals);
    }
  }
  foldLeadingPartialTurn(r);
  scrollToBottom(r);
  const buffered = r.liveBuffer;
  r.liveBuffer = null;
  for (const ev of buffered) {
    handleChatEvent(r, ev);
  }
  // Backgrounded mid-load (fast session switch): the pane cache parked this
  // renderer while we owned liveBuffer, so hand the buffer back to it.
  if (r._liveParked) r.liveBuffer = [];
  // The scroll above runs before async content settles: shiki code
  // highlighting and attachment/image hydration grow the transcript height
  // AFTER it, so the newest turn's chips ended up cut off below the fold on
  // open. Re-pin to the bottom once that settles. Generation-guarded so a
  // newer load/attach started in the meantime never gets yanked.
  void scrollToBottomWhenSettled(r, myGen);
}
