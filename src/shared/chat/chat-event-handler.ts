// Event dispatch for ChatRenderer (ai_todo 123). The per-event live dispatch
// state machine (handleChatEvent), split out of chat-renderer.ts. The history
// bulk replay (bulkLoadEvents) lives in chat-event-bulk-load.ts (ai_todo 314).
// Free functions taking the renderer `r`, sharing its instance state with
// chat-dom-renderer.ts; behavior is byte-identical to the pre-split methods.

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
  stripAuqAnswerBlock,
  RenderedMessage,
} from "./chat-transforms";
import { isRawViewEnabled } from "./message-filter-pref";
import { parseFileEdit } from "./file-edits";
import { canonicalTool } from "./tool-meta";
import {
  resolvePendingQuestionCard,
  tryHandleQuestionToolUse,
  tryHandleQuestionResult,
  tryHandleQuestionSkipped,
} from "./chat-question-card";
import {
  describeActivity,
  scrollToBottom,
  isNearBottom,
  enqueueTurnClose,
  ensureActiveTurnFooter,
  activeTurnTsSpan,
  finalizeStreamingBubble,
  clearRunningHighlight,
} from "./chat-dom-renderer";
import { scheduleFlush, flushRenderNow } from "./flush-scheduler";
import { resolveOrdinalIn } from "./chat-pagination";
import { applyWaitingOnNotification } from "./turn-chips";
import type { ChatRenderer } from "./chat-renderer";

export interface HandleEventOpts {
  /** Skip DOM updates; caller will batch-render later via flushRender. */
  silent?: boolean;
  /** Skip auto-scroll-to-bottom. */
  skipScroll?: boolean;
}

/** Per-handler result the dispatcher folds into the shared post-switch
 *  render/scroll tail (touched -> flush, coalesce -> throttled vs immediate). */
interface EventOutcome {
  touched: boolean;
  coalesce: boolean;
}

/** True if the open turn has produced anything the user would see - real
 *  assistant text, send_message, a user/question row, or an interrupted
 *  notice. Tool calls/results and TodoWrite don't count. */
function turnProducedVisibleContent(r: ChatRenderer): boolean {
  if (r.activeTurnStart === null) return false;
  for (let i = r.activeTurnStart; i < r.messages.length; i++) {
    const m = r.messages[i]!;
    switch (m.kind) {
      case "assistant":
        // Raw narration is hidden by default (chat-narration CSS, see
        // message-filter-pref.ts) - only counts as visible when the user has
        // the raw-chat toggle on for this session, else it wrongly blocks
        // the silent-streak merge below.
        if ((r.sessionId ? isRawViewEnabled(r.sessionId) : false) && blocksToText(m.content ?? []).trim()) return true;
        break;
      case "message":
        if (!m.failed) return true;
        break;
      case "user":
      case "question":
        return true;
      case "system":
        if (m.noiseLabel) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

function handleSessionStartedEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "session_started" }>,
  ts: number,
): EventOutcome {
  r.meta = { model: ev.model || null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
  r.onMetaUpdate?.(r.getMeta());
  r.messages.push({
    kind: "system",
    text: `Session started${ev.model ? ` (${ev.model})` : ""}`,
    ts,
  });
  return { touched: true, coalesce: false };
}

function handleUserMessageEvent(
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
  // (a fired ScheduleWakeup prompt, an autopilot loop tick, etc.) rather
  // than something the human typed - must never look like a real message.
  const isMeta = !isCompact && !isSilent && ev.is_meta;

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

  const auqAnswerText = !isCompact && !isSilent && !isMeta ? extractAuqAnswerText(cleaned) : null;
  const resolvedQuestionCard = auqAnswerText !== null && resolvePendingQuestionCard(r, auqAnswerText);
  // Held prose bundled alongside the answer (bundleHeld keeps it as its own
  // block - see held-messages.ts) still needs to reach the transcript as
  // ordinary content once the sentinel block is folded above.
  const remainderBlocks = resolvedQuestionCard ? stripAuqAnswerBlock(cleaned) : cleaned;
  enqueueTurnClose(r);
  r.setActivity(null);
  r.setTurnStatus(null);
  // Open a new turn footer. The key is a sequence counter (unique even
  // when tests freeze system time); the wall-clock start drives the live
  // elapsed display - history replay uses the message's real ts (not
  // replay-time Date.now()) so a resumed tick's baseline stays correct.
  r.activeTurnChipKey = ++r._chipKeySeq;
  r.activeTurnStreamedText = "";
  r.activeTurnStartedAtMs = ts > 0 ? ts : Date.now();
  r.activeTurnUsage = null;
  r.activeTurnFirstTs = ts > 0 ? ts : 0;
  r.activeTurnLastTs = r.activeTurnFirstTs;
  r.turnTodosBaseline = null;
  if (isCompact) {
    r.messages.push({ kind: "system", text: "Conversation compacted", ts, compactionN: ++r.compactionCount });
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
  } else if (resolvedQuestionCard) {
    // Folded into the question card above instead of a separate bubble -
    // except any held prose that rode along in the same bundle, which
    // still renders as a normal user message (must not be swallowed).
    if (remainderBlocks.length > 0) {
      r.messages.push({ kind: "user", content: remainderBlocks, ts, authorSessionId: ev.author_session_id ?? null });
    }
  } else {
    r.messages.push({ kind: "user", content: cleaned, ts, authorSessionId: ev.author_session_id ?? null });
  }
  r.activeTurnStart = r.messages.length;
  return { touched: true, coalesce: false };
}

function handleAssistantMessageEvent(
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
      if (noiseLabel === "Request interrupted by user" && r.activeTurnChipKey !== null && r.turnTodosBaseline !== null) {
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
      // delivered real output while auqPendingResult was still true) —
      // render it and update status normally.
      const isReemit = joined === (r.auqPreContent ?? "");
      r.auqPendingResult = false;
      r.auqPreContent = null;
      if (!isReemit) {
        r.messages.push(msg);
        r.setTurnStatus(detectStatusToken(joined));
      }
      // Re-emit suppressed: no status update — the post-AUQ final will
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
    if (!r.hydrating && r.turnTodosBaseline === null) {
      const prog = detectProgressToken(joined);
      if (prog) {
        r.turnFooters.setProgress(r.activeTurnChipKey, prog.n, prog.m);
        r.onProgressUpdate?.(prog.n, prog.m);
      }
    }
  }
  return { touched: true, coalesce };
}

function handleToolUseEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "tool_use" }>,
  ts: number,
): EventOutcome {
  if (tryHandleQuestionToolUse(r, ev, ts)) return { touched: true, coalesce: false };
  // Explicit inbox message: the AI's opt-in way to surface a chat bubble
  // (vs. narration tool calls, hidden by default - see message-filter-pref.ts).
  if (ev.tool_name === "mcp__cc_conductor__send_message" && !ev.parent_tool_use_id) {
    const text = typeof (ev.input as { text?: unknown })?.text === "string"
      ? (ev.input as { text: string }).text : "";
    r.messages.push({ kind: "message", text, id: ev.id, ts, parentToolUseId: null });
    return { touched: true, coalesce: false };
  }
  // Revise/retract a message Claude already sent (see resolveOrdinalIn in
  // chat-pagination.ts for the addressing scheme and its window). Edit is a
  // silent in-place swap; retract leaves a thin struck placeholder. Either
  // way the row clears `dimmed`, so answering an interrupt un-dims it.
  if (ev.tool_name === "mcp__cc_conductor__update_message" && !ev.parent_tool_use_id) {
    r._updateMsgToolUseIds.add(ev.id);
    const input = (ev.input ?? {}) as { message?: unknown; text?: unknown; retract?: unknown };
    const idx = resolveOrdinalIn(r.messages, typeof input.message === "number" ? input.message : NaN);
    if (idx >= 0) {
      const prev = r.messages[idx]!;
      r.messages[idx] = input.retract === true
        ? { ...prev, retracted: true, dimmed: false }
        : { ...prev, text: typeof input.text === "string" ? input.text : prev.text, dimmed: false };
      r.dirtyIndices.add(idx);
    }
    return { touched: true, coalesce: false };
  }
  // TodoWrite drives the step-checklist that replaces the visual role of
  // the <cc-progress:N/M> marker bar (chat-tools.css .todo-checklist).
  // Renders straight into the turn footer via turnFooters - never a
  // message row.
  if (ev.tool_name === "TodoWrite" && !ev.parent_tool_use_id) {
    r._todoWriteToolUseIds.add(ev.id);
    const rawTodos = (ev.input as { todos?: { content: string; status: string; activeForm?: string }[] } | null)?.todos;
    const todos = Array.isArray(rawTodos) ? rawTodos : [];
    let steps: { label: string; status: "pending" | "active" | "done" }[];
    if (r.hydrating && r.lastTodosSnapshot === null) {
      // Cold-reopen degrade: first TodoWrite seen in a bulk-load batch
      // with no prior snapshot in the loaded window - render a flat
      // settled checklist (no diff, no new/carryover distinction). No
      // special no-animation handling needed: hydrating renders happen
      // while the transcript is hidden (revealTranscript), so any CSS
      // animation on these rows plays out unseen before the reveal.
      steps = todos.map((t) => ({
        label: t.content,
        status: t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending",
      }));
    } else {
      if (r.turnTodosBaseline === null) {
        r.turnTodosBaseline = r.lastTodosSnapshot ? r.lastTodosSnapshot.map((b) => ({ ...b })) : [];
      }
      const baseline = r.turnTodosBaseline;
      steps = [];
      for (const t of todos) {
        const baseEntry = baseline.find((b) => b.content === t.content);
        if (!baseEntry) {
          steps.push({
            label: t.content,
            status: t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending",
          });
        } else if (baseEntry.status !== t.status) {
          // Changed-status entry: never mapped back to "pending" (a
          // regression to pending can't happen under TodoWrite's normal
          // pending -> in_progress -> completed progression; "active" is
          // the fallback if it somehow did - judgment call, unpinned by
          // the spec).
          steps.push({
            label: t.content,
            status: t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "active",
          });
        }
        // else: identical content+status to baseline - carryover noise, filtered out.
      }
    }
    if (r.activeTurnChipKey !== null) {
      r.turnFooters.ensureTodoChecklist(r.activeTurnChipKey);
      r.turnFooters.updateTodoSteps(r.activeTurnChipKey, steps);
    }
    r.lastTodosSnapshot = todos.map((t) => ({ content: t.content, status: t.status }));
    if (!r.hydrating) {
      const active = todos.find((t) => t.status === "in_progress");
      r.onTodoActivityUpdate?.(active?.activeForm ?? null);
    }
    return { touched: true, coalesce: false };
  }
  r.messages.push({
    kind: "tool_use",
    tool: ev.tool_name,
    input: ev.input,
    id: ev.id,
    ts,
    parentToolUseId: ev.parent_tool_use_id ?? null,
  });
  const view = parseFileEdit(ev.tool_name, ev.input);
  if (view) {
    r.fileEdits.push(view);
    // Suppressed during history replay so the header badge doesn't count
    // up; the final total is fired once when bulkLoadEvents finishes.
    if (!r.hydrating) r.onFileEditsChanged?.(r.getFileEdits());
  }
  {
    const t = r.tallyState.tallyToolUse(ev.tool_name, ev.input, ev.id);
    if (t) r.onToolTally?.(t);
  }
  if (!r.hydrating && ev.tool_name === "Skill") {
    const inp = ev.input as Record<string, unknown>;
    if (typeof inp?.skill === "string" && inp.skill === "next-ai-prompt") {
      r._nextAiPromptPending = true;
    }
  }
  r.activityToolCanon = canonicalTool(ev.tool_name);
  r.setActivity(describeActivity(ev.tool_name, ev.input));
  r.outstandingActivityToolIds.add(ev.id);
  return { touched: true, coalesce: false };
}

function handleToolResultEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "tool_result" }>,
  ts: number,
): EventOutcome {
  // TodoWrite's tool_result carries no user-facing content - absorb it
  // silently (no message row, no tool tally bump), mirroring how the AUQ
  // branch below absorbs its own result but simpler: no card to update.
  if (r._todoWriteToolUseIds.delete(ev.tool_use_id)) return { touched: true, coalesce: false };
  if (r._updateMsgToolUseIds.delete(ev.tool_use_id)) return { touched: true, coalesce: false };
  if (tryHandleQuestionResult(r, ev)) return { touched: true, coalesce: false };
  // Ack for a send_message call: text already came from the tool_use
  // input, so absorb silently - no visible tool_result row. A REJECTED send
  // must also drop the bubble: the row is built from the tool_use input, so
  // without this it renders anyway and the shortened retry stacks a
  // near-duplicate underneath it.
  const mIdx = r.messages.findIndex((m) => m.kind === "message" && m.id === ev.tool_use_id);
  if (mIdx >= 0) {
    if (ev.is_error) {
      r.messages[mIdx] = { ...r.messages[mIdx]!, failed: true };
      r.dirtyIndices.add(mIdx);
    }
    return { touched: true, coalesce: false };
  }
  r.messages.push({
    kind: "tool_result",
    tool_use_id: ev.tool_use_id,
    output: ev.output,
    is_error: ev.is_error,
    ts,
  });
  // Only idle the label once no tool from this turn is outstanding (see
  // outstandingActivityToolIds) - text stays, idle:true just flags it so a
  // fast result doesn't flash "Thinking...". keepChip only clears the
  // highlight; the chip keeps pulsing till the next tool_use or close.
  if (r.outstandingActivityToolIds.delete(ev.tool_use_id) && r.outstandingActivityToolIds.size === 0) {
    r.setActivity(r.lastActivity, { keepChip: true, idle: true });
  }
  // The tally counts didn't change, but a result can complete a custom
  // view (e.g. an AskUserQuestion answer): nudge the statusline so an open
  // popover re-renders from the now-updated messages.
  r.onToolTally?.(r.tallyState.build());
  return { touched: true, coalesce: false };
}

function handleNotificationEvent(r: ChatRenderer, ev: Extract<ChatEvent, { type: "notification" }>): EventOutcome {
  if (tryHandleQuestionSkipped(r, ev)) return { touched: true, coalesce: false };
  // todo 675: the waiting-on target rides a generic Notification (not its own
  // ChatEvent variant - types/chat.rs is owned elsewhere right now). It only
  // updates the current turn's footer chip, never a message row.
  if (ev.kind === "waiting_on") {
    applyWaitingOnNotification(r.turnFooters, r.activeTurnChipKey, ev.body);
    return { touched: true, coalesce: false };
  }
  r.messages.push({ kind: "notification", text: ev.body, ts: Date.now() });
  return { touched: true, coalesce: false };
}

function handleSessionEndedEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "session_ended" }>,
  ts: number,
): EventOutcome {
  enqueueTurnClose(r);
  r.messages.push({
    kind: "system",
    text: `Session ended${ev.exit_code !== null ? ` (exit ${ev.exit_code})` : ""}`,
    ts,
  });
  return { touched: true, coalesce: false };
}

/** Settle event - locks in the meta row's final numbers and flushes
 *  immediately, bypassing the shared touched/coalesce tail below since it
 *  never adds a message row and must never be throttled behind it. */
function handleTurnUsageEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "turn_usage" }>,
  opts: HandleEventOpts,
): void {
  const totalCtx = Number(ev.input_tokens) + Number(ev.cache_creation_input_tokens) + Number(ev.cache_read_input_tokens);
  console.debug("[ctx] turn_usage", { model: ev.model, input: Number(ev.input_tokens), cacheCreate: Number(ev.cache_creation_input_tokens), cacheRead: Number(ev.cache_read_input_tokens), output: Number(ev.output_tokens), totalCtx });
  r.meta.inputTokens = totalCtx;
  r.meta.totalCostUsd += ev.total_cost_usd;
  r.meta.hasUsage = true;
  if (ev.has_thinking) r.meta.hasThinking = true;
  if (ev.model) r.meta.model = ev.model;
  r._cumulative.input += Number(ev.input_tokens) || 0;
  r._cumulative.output += Number(ev.output_tokens) || 0;
  r._cumulative.cacheCreate += Number(ev.cache_creation_input_tokens) || 0;
  r._cumulative.cacheRead += Number(ev.cache_read_input_tokens) || 0;
  r._cumulative.costUsd += Number(ev.total_cost_usd) || 0;
  r._cumulative.turns += 1;
  r.onMetaUpdate?.(r.getMeta());
  // Accumulate the turn's COMBINED usage. History replays one usage
  // event per assistant line: output/cache/cost sum, input is the
  // latest (context size), duration keeps the max (only live's single
  // result event carries a real one). The meta row freezes from these
  // totals - at turn close for history, right here for live.
  if (r.activeTurnChipKey !== null) {
    const u = r.activeTurnUsage ?? {
      durationMs: 0, outputTokens: 0, inputTokens: 0,
      cacheCreate: 0, cacheRead: 0, costUsd: 0,
    };
    u.outputTokens += Number(ev.output_tokens) || 0;
    u.inputTokens = Number(ev.input_tokens) || u.inputTokens;
    u.cacheCreate += Number(ev.cache_creation_input_tokens) || 0;
    u.cacheRead += Number(ev.cache_read_input_tokens) || 0;
    u.costUsd += Number(ev.total_cost_usd) || 0;
    u.durationMs = Math.max(u.durationMs, Number(ev.duration_ms) || 0);
    // Fold: only the turn's LAST assistant line carries the real
    // reported status (tool round-trip lines in between have none) -
    // keep the latest non-null value, never overwrite with null.
    if (ev.awaiting) u.awaiting = ev.awaiting;
    // Additive to the assistant_message branch's detectStatusToken calls
    // below (those still resolve pre-435 history); this drives it live.
    // A falsy awaiting here (report_turn_status discarded by a gen-mismatch
    // race, todo 621) still needs a terminal status, not a permanent stall.
    r.setTurnStatus(ev.awaiting ? (ev.awaiting as "done" | "question" | "waiting" | "working") : "done");
    r.activeTurnUsage = u;
    // Live path: settle immediately so the row stops ticking the moment
    // usage lands. Watched external sessions stream one usage per
    // assistant line; each re-settle overwrites with the bigger sums.
    if (!opts.silent) {
      ensureActiveTurnFooter(r);
      r.turnFooters.settleMetaRow(r.activeTurnChipKey, {
        ...u,
        durationMs: u.durationMs > 0 ? u.durationMs : activeTurnTsSpan(r),
      });
      // The turn actually completed here, not only on the next turn's
      // start - settle any still-pulsing tool chip now (ChatEvent::SessionEnded,
      // the other clear site, is never constructed backend-side today).
      clearRunningHighlight(r);
    }
  }
  if (!opts.silent) {
    // turn_usage is a settle event (the meta row locking in its final
    // numbers) - flush now, bypassing scheduleFlush's throttle, so it's
    // never delayed behind a coalescing window opened by prior deltas.
    flushRenderNow(r);
  }
}

export function handleChatEvent(r: ChatRenderer, ev: ChatEvent, opts: HandleEventOpts = {}): void {
  const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
  // Capture before mutating: if the user had scrolled up to read history, we
  // preserve their position instead of yanking them to the bottom on a live
  // update. Sending a user_message leaves them at the bottom anyway, so the
  // gate naturally re-engages auto-scroll for their own messages.
  const wasAtBottom = isNearBottom(r);
  let outcome: EventOutcome = { touched: false, coalesce: false };
  switch (ev.type) {
    case "session_started": outcome = handleSessionStartedEvent(r, ev, ts); break;
    case "user_message": outcome = handleUserMessageEvent(r, ev, ts); break;
    case "assistant_message": outcome = handleAssistantMessageEvent(r, ev, ts); break;
    case "tool_use": outcome = handleToolUseEvent(r, ev, ts); break;
    case "tool_result": outcome = handleToolResultEvent(r, ev, ts); break;
    case "notification": outcome = handleNotificationEvent(r, ev); break;
    case "session_ended": outcome = handleSessionEndedEvent(r, ev, ts); break;
    case "turn_usage": handleTurnUsageEvent(r, ev, opts); return;
    default: break;
  }
  const { touched, coalesce } = outcome;
  if (!touched) return;
  // Track the turn's timestamp span (history duration fallback). Live
  // events carry timestamp 0 and never move these.
  if (ts > 0 && r.activeTurnChipKey !== null) {
    if (r.activeTurnFirstTs === 0) r.activeTurnFirstTs = ts;
    if (ts > r.activeTurnLastTs) r.activeTurnLastTs = ts;
  }
  if (!opts.silent) {
    const afterFlush = () => {
      if (!opts.skipScroll && wasAtBottom) scrollToBottom(r);
    };
    if (coalesce) {
      // Throttled: this is the path a fast token stream drives once per
      // content_block_delta (ai_todo streaming-render O(n^2) fix, Fix 2).
      // scheduleFlush renders the first event of a burst immediately and
      // coalesces the rest into one trailing flush. The scroll check rides
      // along as `afterFlush` so it always reads a scrollHeight fresh off
      // the actual DOM update, not a stale one from a throttled call.
      scheduleFlush(r, afterFlush);
    } else {
      // Every other touched event type (tool_use, tool_result, user_message,
      // finalized assistant_message, ...) is one-shot, not a hot loop -
      // render immediately, and cancel any streaming throttle window still
      // open from before this event so its DOM update isn't left pending.
      flushRenderNow(r);
      afterFlush();
    }
  }
}
