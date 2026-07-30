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
  activeTurnTsSpan,
  beginRevealHold,
  foldLeadingPartialTurn,
  scrollToBottomWhenSettled,
} from "./chat-dom-renderer";
import { handleChatEvent } from "./chat-event-handler";
import type { ChatRenderer } from "./chat-renderer";

export interface BulkLoadOpts {
  /** True for a still-live session (resumes ticking on reload); false
   *  (default) for read-only History, where nothing streams in again. */
  resumeLiveTicking?: boolean;
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
  r.activityToolCanon = null;
  r.activeToolGroups.clear();
  r.activeTurnStart = null;
  r.compactionCount = 0;
  r.resetActiveTurnMeta();
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
  const CHUNK = 8;
  for (let i = 0; i < events.length; i += CHUNK) {
    if (r._bulkGen !== myGen) { r.liveBuffer = null; r.hydrating = false; return; }
    for (let j = i; j < Math.min(i + CHUNK, events.length); j++) {
      handleChatEvent(r, events[j]!, { silent: true, skipScroll: true });
    }
    flushRender(r);
    if (i + CHUNK < events.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (r._bulkGen !== myGen) { r.liveBuffer = null; r.hydrating = false; return; }
  // History replay is done: deliver the FINAL header badge + thinking-bar
  // state in ONE shot (per-event updates were gated above so the badge didn't
  // count up and the bar didn't flip through every past activity). A done turn
  // leaves lastActivity null -> the bar clears; a still-busy turn shows its
  // last activity, and buffered live events below take over from there.
  r.hydrating = false;
  r.onFileEditsChanged?.(r.getFileEdits());
  r.onActivityUpdate?.(r.lastActivity);
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
  // The scroll above runs before async content settles: shiki code
  // highlighting and attachment/image hydration grow the transcript height
  // AFTER it, so the newest turn's chips ended up cut off below the fold on
  // open. Re-pin to the bottom once that settles. Generation-guarded so a
  // newer load/attach started in the meantime never gets yanked.
  void scrollToBottomWhenSettled(r, myGen);
}
