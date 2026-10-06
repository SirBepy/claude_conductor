// Message-content handlers (user_message, assistant_message) split out of
// chat-event-handler.ts (todo 912): the two largest handlers left after the
// tool-lifecycle (chat-event-handler-tools.ts, todo 746) and session/usage
// lifecycle (chat-event-handler-lifecycle.ts) splits. handleChatEvent still
// dispatches into these exactly as before; behavior is byte-identical.

import type { ChatEvent } from "../../types/ipc.generated";
import { blocksToText } from "./content-blocks";
import {
  cleanUserBlocks,
  isCompactUserMessage,
  detectStatusToken,
  detectProgressToken,
  isSilentSystemUserMessage,
  isResumeContinuationUserMessage,
  classifyMetaTurn,
  noiseAssistantLabel,
  extractAuqAnswerText,
  extractAuqAnswerCardId,
  stripAuqAnswerBlock,
  extractAuqExtraText,
  stripAuqExtraBlock,
  compactionOrdinal,
  RenderedMessage,
} from "./chat-transforms";
import { turnProducedVisibleContent } from "./turn-visible-content";
import {
  resolvePendingQuestionCard,
  resolvePendingQuestionExtra,
} from "./chat-question-card";
import { finalizeStreamingBubble } from "./chat-dom-renderer";
import {
  enqueueTurnClose,
  clearRunningHighlight,
} from "./chat-turn-fold";
import type { ChatRenderer } from "./chat-renderer";

// Structurally identical to chat-event-handler.ts's own (unexported)
// EventOutcome - duplicated rather than exported so this split adds no new
// export surface to that file, same as chat-event-handler-tools.ts (todo 746)
// and chat-event-handler-lifecycle.ts before it.
interface EventOutcome {
  touched: boolean;
  coalesce: boolean;
}

export function handleUserMessageEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "user_message" }>,
  ts: number,
): EventOutcome {
  r.auqPendingResult = false;
  // Only a message the USER actually sent (or a compaction) is a turn
  // boundary. Real streams deliver every tool result as a user-role
  // line whose blocks the parser drops (content empty) - rotating the
  // turn for those split the footer per tool cycle ("tokens split up
  // per answer"). Decide visibility FIRST, rotate after.
  const isCompact = isCompactUserMessage(ev.content);
  const cleaned = isCompact ? [] : cleanUserBlocks(ev.content);
  if (!isCompact && cleaned.length === 0) return { touched: false, coalesce: false };
  // Drop the resume system's "Continue from where you left off." turn - the
  // user never typed it; the assistant's "Continuing chat" notice is the marker.
  if (!isCompact && isResumeContinuationUserMessage(cleaned)) return { touched: false, coalesce: false };
  // Silent system turns (e.g. rate-limit auto-continue) rotate the turn
  // chip so usage is tracked but render no user bubble.
  const isSilent = !isCompact && isSilentSystemUserMessage(cleaned);
  // isMeta:true marks a turn Claude Code injected into its own transcript
  // (a fired ScheduleWakeup prompt, an autopilot loop tick, etc.) - renders as
  // a system note. A peer channel wake (todo 743) is ALSO is_meta but carries
  // a known sender, so it renders as an ordinary authored bubble instead.
  const isMeta = !isCompact && !isSilent && ev.is_meta && !ev.author_session_id;

  // Silent auto-continue streak: the harness re-invokes with a synthetic
  // "continue" whenever the prior turn rendered nothing. Fold it into
  // the ongoing footer (same chip key) instead of spamming a new empty
  // row per retry.
  if (isMeta && r.activeTurnChipKey !== null && !turnProducedVisibleContent(r)) {
    finalizeStreamingBubble(r);
    clearRunningHighlight(r);
    // Deliberately NOT cleared: activeToolGroups (tool chips keep
    // accumulating into the same strip), activeTurnUsage/Todos baseline
    // (same reason), and no new chip key is minted.
    r.setActivity(null);
    r.outstandingActivityToolIds.clear();
    r.setTurnStatus(null);
    if (r.silentStreakBoundaryIndex !== null) {
      r.silentStreakCount += 1;
      const boundary = r.messages[r.silentStreakBoundaryIndex] as RenderedMessage;
      r.messages[r.silentStreakBoundaryIndex] = { ...boundary, streakCount: r.silentStreakCount };
      r.dirtyIndices.add(r.silentStreakBoundaryIndex);
      if (boundary.metaKind) {
        r.turnFooters.ensureMetaChip(r.activeTurnChipKey, {
          kind: boundary.metaKind,
          label: boundary.text ?? "",
          detail: boundary.metaDetail ?? "",
          streakCount: r.silentStreakCount,
        });
      }
    }
    r.activeTurnStart = r.messages.length;
    return { touched: true, coalesce: false };
  }

  // A peer's relayed message is not a turn of its own. Everything between two
  // of the USER's own messages is one block, so an authored message stays in
  // the open turn and folds into its chip line (foldAuthoredIntoStrip) instead
  // of rotating the footer and splitting the run in half.
  if (!isCompact && !isSilent && ev.author_session_id && r.activeTurnChipKey !== null) {
    r.messages.push({ kind: "user", content: cleaned, ts, authorSessionId: ev.author_session_id });
    return { touched: true, coalesce: false };
  }

  // Runs before the held mid-turn branch below: the MCP ask is fire-and-forget,
  // so its answer often arrives while the asking turn is still running, as a
  // held message nudge.rs injects mid-turn.
  const auqAnswerText = !isCompact && !isSilent && !isMeta ? extractAuqAnswerText(cleaned) : null;
  const resolvedQuestionCard = auqAnswerText !== null
    && resolvePendingQuestionCard(r, auqAnswerText, extractAuqAnswerCardId(cleaned));
  // Independent of the answer fold above - the card's own extra-message note
  // can ride the same event (a distinct block) or arrive as its own later
  // event (the in-band `delivered` path resolves the answer from the
  // tool_result alone, so the note is the ONLY sentinel in its message).
  const auqExtraText = !isCompact && !isSilent && !isMeta ? extractAuqExtraText(cleaned) : null;
  const resolvedQuestionExtra = auqExtraText !== null && resolvePendingQuestionExtra(r, auqExtraText);
  // Held prose bundled alongside either sentinel (bundleHeld keeps them as
  // their own blocks - see held-messages.ts) still needs to reach the
  // transcript as ordinary content once the sentinel block(s) are folded above.
  let remainderBlocks = resolvedQuestionCard ? stripAuqAnswerBlock(cleaned) : cleaned;
  if (resolvedQuestionExtra) remainderBlocks = stripAuqExtraBlock(remainderBlocks);

  // A held message nudge.rs delivered mid-turn (sessions-wiring.ts's
  // `heldDelivered` marker on the synthetic pushSynthetic event) is prose the
  // user typed while THIS turn kept running - not a new turn. Finalize
  // whatever text streamed so far in place (so it freezes instead of
  // silently growing underneath the bubble about to render below it) without
  // the generic enqueueTurnClose: that would rotate activeTurnChipKey and
  // visually split the tool-chip strip around a message that never actually
  // ended the turn. The NEXT streaming delta then opens a fresh bubble
  // (streamingIndex is null again) that only grows AFTER this one, so the
  // held bubble stays above everything the turn streams from here on,
  // including through the turn's eventual close (todo 945).
  const isHeldMidTurn = !!(ev as { heldDelivered?: boolean }).heldDelivered;
  if (!isCompact && !isSilent && isHeldMidTurn && r.activeTurnChipKey !== null) {
    finalizeStreamingBubble(r);
    if (remainderBlocks.length > 0) {
      r.messages.push({ kind: "user", content: remainderBlocks, ts, authorSessionId: null });
    }
    return { touched: true, coalesce: false };
  }

  enqueueTurnClose(r);
  r.setActivity(null);
  r.setTurnStatus(null);
  // Open a new turn footer. The key is a sequence counter (unique even
  // when tests freeze system time); the wall-clock start drives the live
  // elapsed display - history replay uses the message's real ts (not
  // replay-time Date.now()) so a resumed tick's baseline stays correct.
  r.activeTurnChipKey = ++r._chipKeySeq;
  r.activeTurnIsMeta = isMeta;
  r.activeTurnIsContinuation = isSilent;
  r.activeTurnStreamedText = "";
  r.activeTurnStartedAtMs = ts > 0 ? ts : Date.now();
  r.activeTurnUsage = null;
  r.activeTurnFirstTs = ts > 0 ? ts : 0;
  r.activeTurnLastTs = r.activeTurnFirstTs;
  r.turnTodosBaseline = null;
  if (isCompact) {
    // compactionN is derived from the assembled list (compactionOrdinal),
    // not a threaded counter, so this agrees with eventToRenderedMessage's
    // isCompaction-only signal by construction (ai_todo 742).
    const compactionMsg: RenderedMessage = { kind: "system", text: "Conversation compacted", ts, isCompaction: true };
    r.messages.push(compactionMsg);
    compactionMsg.compactionN = compactionOrdinal(r.messages, r.messages.length - 1);
  } else if (isSilent) {
    r.messages.push({ kind: "system", text: "Continuing session…", ts });
  } else if (isMeta) {
    r.silentStreakBoundaryIndex = r.messages.length;
    r.silentStreakCount = 1;
    const meta = classifyMetaTurn(cleaned);
    r.messages.push({ kind: "system", text: meta.label, metaKind: meta.kind, metaDetail: meta.detail, ts });
    // Visible render is the inline chip below - this row is streak
    // bookkeeping only now (renderMessage's meta-marker div stays hidden).
    r.turnFooters.ensureMetaChip(r.activeTurnChipKey, {
      kind: meta.kind,
      label: meta.label,
      detail: meta.detail,
      streakCount: 1,
    });
  } else if (resolvedQuestionCard || resolvedQuestionExtra) {
    // Folded into the card above - held prose still renders below. Uses
    // remainderBlocks (sentinels stripped), never raw `cleaned`, or an
    // extra-only event (resolvedQuestionCard false) leaks its sentinel text.
    if (remainderBlocks.length > 0) {
      r.messages.push({ kind: "user", content: remainderBlocks, ts, authorSessionId: ev.author_session_id ?? null });
    }
  } else {
    r.messages.push({ kind: "user", content: cleaned, ts, authorSessionId: ev.author_session_id ?? null });
  }
  // A peer message that had to open a turn (nothing was live yet) still belongs
  // on that turn's chip line, so the range keeps it - unlike the user's own
  // opener, which renders as the bubble above the footer.
  const authoredOpener = !isCompact && !isSilent && !!ev.author_session_id
    && (r.messages[r.messages.length - 1] as RenderedMessage | undefined)?.kind === "user";
  r.activeTurnStart = authoredOpener ? r.messages.length - 1 : r.messages.length;
  r.activeTurnFoldStart = r.activeTurnStart;
  return { touched: true, coalesce: false };
}

export function handleAssistantMessageEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "assistant_message" }>,
  ts: number,
): EventOutcome {
  if (!ev.streaming) {
    const msgText = blocksToText(ev.content).trim();
    const noiseLabel = noiseAssistantLabel(msgText);
    if (noiseLabel !== null) {
      // Internal CLI messages become inline system notices.
      // Interrupted turn with an active checklist: mark its in-flight
      // step interrupted BEFORE the streaming bubble finalizes below (the
      // closest thing to a "settle" step in this branch), so the
      // checklist visually reflects the cancel rather than being frozen
      // mid-spin.
      if (noiseLabel === "Request interrupted by user" && r.activeTurnChipKey !== null
        && r.turnFooters.hasTodoChecklist(r.activeTurnChipKey)) {
        r.turnFooters.interruptTodoChecklist(r.activeTurnChipKey);
      }
      // Finalize any in-progress streaming bubble first.
      if (r.streamingIndex !== null) {
        const existing = r.messages[r.streamingIndex] as RenderedMessage;
        r.messages[r.streamingIndex] = { ...existing, streaming: false };
        r.dirtyIndices.add(r.streamingIndex);
        r.streamingIndex = null;
      }
      // When a "Continuing session…" marker was just emitted (rate-limit
      // auto-continue silent user turn), the assistant "Continuing chat"
      // fires immediately after for the same resume event. Suppress the
      // duplicate so only one resume notice shows.
      const prevMsg = r.messages[r.messages.length - 1];
      if (prevMsg?.kind === "system" && prevMsg.text === "Continuing session…") return { touched: false, coalesce: false };
      // Everything Claude said in the cancelled turn is now suspect - it
      // was mid-thought. Dim it on sight rather than waiting for Claude to
      // notice; Claude clears the dim by revising or retracting the row.
      if (noiseLabel === "Request interrupted by user" && r.activeTurnStart !== null) {
        for (let i = r.activeTurnStart; i < r.messages.length; i++) {
          const m = r.messages[i]!;
          if (m.kind !== "message" || m.retracted) continue;
          r.messages[i] = { ...m, dimmed: true };
          r.dirtyIndices.add(i);
        }
      }
      r.messages.push({ kind: "system", text: noiseLabel, ts, noiseLabel: true });
      r.setTurnStatus(null);
      return { touched: true, coalesce: false };
    }
  }
  const msg: RenderedMessage = {
    kind: "assistant",
    content: ev.content,
    streaming: ev.streaming,
    ts,
  };
  let coalesce = false;
  if (ev.streaming) {
    // The hot loop: one of these per content_block_delta token. Eligible
    // for the trailing-edge throttle below (Fix 2).
    coalesce = true;
    if (r.streamingIndex !== null) {
      r.messages[r.streamingIndex] = msg;
      r.dirtyIndices.add(r.streamingIndex);
    } else {
      r.streamingIndex = r.messages.length;
      r.messages.push(msg);
    }
  } else {
    const joined = blocksToText(ev.content);
    if (r.streamingIndex !== null) {
      r.messages[r.streamingIndex] = msg;
      r.dirtyIndices.add(r.streamingIndex);
      r.streamingIndex = null;
      r.auqPendingResult = false;
      r.auqPreContent = null;
      r.setTurnStatus(detectStatusToken(joined));
    } else if (r.auqPendingResult) {
      // The result line re-emits the pre-AUQ text as a finalized
      // AssistantMessage. Suppress it only if the content matches what was
      // in the streaming slot when AUQ fired. If it doesn't match, this is
      // genuine post-AUQ content (e.g. the file watcher won the race and
      // delivered real output while auqPendingResult was still true) -
      // render it and update status normally.
      const isReemit = joined === (r.auqPreContent ?? "");
      r.auqPendingResult = false;
      r.auqPreContent = null;
      if (!isReemit) {
        r.messages.push(msg);
        r.setTurnStatus(detectStatusToken(joined));
      }
      // Re-emit suppressed: no status update - the post-AUQ final will
      // fire setTurnStatus when it arrives via its own streaming path.
    } else {
      r.messages.push(msg);
      r.setTurnStatus(detectStatusToken(joined));
    }
  }
  // Update live token estimate and check for a progress marker.
  if (r.activeTurnChipKey !== null) {
    const joined = blocksToText(ev.content);
    r.activeTurnStreamedText = joined;
    r.turnFooters.updateLiveTokenEstimate(r.activeTurnChipKey, joined);
    // Suppressed once a todo checklist owns this turn's visual progress
    // (the marker is still parsed out of the displayed text elsewhere -
    // only its bar/callback is skipped here to avoid a dual indicator).
    if (!r.turnFooters.hasTodoChecklist(r.activeTurnChipKey)) {
      const prog = detectProgressToken(joined);
      if (prog) {
        r.lastProgress = prog;
        if (!r.hydrating) {
          r.turnFooters.setProgress(r.activeTurnChipKey, prog.n, prog.m);
          r.onProgressUpdate?.(prog.n, prog.m);
        }
      }
    }
  }
  return { touched: true, coalesce };
}
