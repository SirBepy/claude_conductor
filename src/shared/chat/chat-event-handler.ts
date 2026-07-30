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
  detectHandoffToken,
  isSilentSystemUserMessage,
  isResumeContinuationUserMessage,
  metaTurnLabel,
  noiseAssistantLabel,
  extractAuqAnswerText,
  RenderedMessage,
} from "./chat-transforms";
import { parseFileEdit } from "./file-edits";
import { canonicalTool } from "./tool-meta";
import {
  describeActivity,
  scrollToBottom,
  isNearBottom,
  enqueueTurnClose,
  ensureActiveTurnFooter,
  activeTurnTsSpan,
} from "./chat-dom-renderer";
import { scheduleFlush, flushRenderNow } from "./flush-scheduler";
import type { ChatRenderer } from "./chat-renderer";

export interface HandleEventOpts {
  /** Skip DOM updates; caller will batch-render later via flushRender. */
  silent?: boolean;
  /** Skip auto-scroll-to-bottom. */
  skipScroll?: boolean;
}

/** Fold a fire-and-forget AUQ answer message back into the question card it
 *  answers (see permission-modal/index.ts onSubmit), so the transcript shows
 *  the card resolved with the real answers instead of stuck on "awaiting
 *  answer" plus a separate answer bubble. Only one AUQ can be in flight per
 *  session at a time, so the most recent still-unresolved question card is
 *  always the right match. Returns false if none is found (caller falls back
 *  to rendering a normal bubble, same as before this existed). */
function resolvePendingQuestionCard(r: ChatRenderer, answerText: string): boolean {
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i]!;
    if (m.kind === "question" && m.text === undefined) {
      r.messages[i] = { ...m, text: answerText };
      r.dirtyIndices.add(i);
      return true;
    }
  }
  return false;
}

export function handleChatEvent(r: ChatRenderer, ev: ChatEvent, opts: HandleEventOpts = {}): void {
  const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
  // Capture before mutating: if the user had scrolled up to read history, we
  // preserve their position instead of yanking them to the bottom on a live
  // update. Sending a user_message leaves them at the bottom anyway, so the
  // gate naturally re-engages auto-scroll for their own messages.
  const wasAtBottom = isNearBottom(r);
  let touched = false;
  // Set only by the streaming assistant_message accumulation branch below -
  // the true O(n^2) hot path (one event per content_block_delta token). Every
  // other event type (tool_use, tool_result, user_message, finalized
  // assistant_message, ...) is one-shot per user/tool action, not a hot
  // loop, so it keeps rendering immediately - preserving the existing
  // synchronous "handleEvent then assert on the DOM" test contract for those.
  let coalesce = false;
  switch (ev.type) {
    case "session_started":
      r.meta = { model: ev.model || null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
      r.onMetaUpdate?.(r.getMeta());
      r.messages.push({
        kind: "system",
        text: `Session started${ev.model ? ` (${ev.model})` : ""}`,
        ts,
      });
      touched = true;
      break;
    case "user_message": {
      r.auqPendingResult = false;
      // Only a message the USER actually sent (or a compaction) is a turn
      // boundary. Real streams deliver every tool result as a user-role
      // line whose blocks the parser drops (content empty) - rotating the
      // turn for those split the footer per tool cycle ("tokens split up
      // per answer"). Decide visibility FIRST, rotate after.
      const isCompact = isCompactUserMessage(ev.content);
      const cleaned = isCompact ? [] : cleanUserBlocks(ev.content);
      if (!isCompact && cleaned.length === 0) break;
      // Drop the resume system's "Continue from where you left off." turn - the
      // user never typed it; the assistant's "Continuing chat" notice is the marker.
      if (!isCompact && isResumeContinuationUserMessage(cleaned)) break;
      // Silent system turns (e.g. rate-limit auto-continue) rotate the turn
      // chip so usage is tracked but render no user bubble.
      const isSilent = !isCompact && isSilentSystemUserMessage(cleaned);
      // isMeta:true marks a turn Claude Code injected into its own transcript
      // (a fired ScheduleWakeup prompt, an autopilot loop tick, etc.) rather
      // than something the human typed - must never look like a real message.
      const isMeta = !isCompact && !isSilent && ev.is_meta;
      const auqAnswerText = !isCompact && !isSilent && !isMeta ? extractAuqAnswerText(cleaned) : null;
      const resolvedQuestionCard = auqAnswerText !== null && resolvePendingQuestionCard(r, auqAnswerText);
      enqueueTurnClose(r);
      r.setActivity(null);
      r.setTurnStatus(null);
      // Open a new turn footer. The key is a sequence counter (unique even
      // when tests freeze system time); the wall-clock start drives the
      // live elapsed display.
      r.activeTurnChipKey = ++r._chipKeySeq;
      r.activeTurnStreamedText = "";
      r.activeTurnStartedAtMs = Date.now();
      r.activeTurnUsage = null;
      r.activeTurnFirstTs = ts > 0 ? ts : 0;
      r.activeTurnLastTs = r.activeTurnFirstTs;
      r.turnTodosBaseline = null;
      if (isCompact) {
        r.messages.push({ kind: "system", text: "Conversation compacted", ts, compactionN: ++r.compactionCount });
      } else if (isSilent) {
        r.messages.push({ kind: "system", text: "Continuing session…", ts });
      } else if (isMeta) {
        r.messages.push({ kind: "system", text: metaTurnLabel(cleaned), ts });
      } else if (resolvedQuestionCard) {
        // Folded into the question card above instead of a separate bubble.
      } else {
        r.messages.push({ kind: "user", content: cleaned, ts });
      }
      r.activeTurnStart = r.messages.length;
      touched = true;
      break;
    }
    case "assistant_message": {
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
          if (prevMsg?.kind === "system" && prevMsg.text === "Continuing session…") break;
          r.messages.push({ kind: "system", text: noiseLabel, ts, noiseLabel: true });
          r.setTurnStatus(null);
          touched = true;
          break;
        }
      }
      const msg: RenderedMessage = {
        kind: "assistant",
        content: ev.content,
        streaming: ev.streaming,
        ts,
      };
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
        if (!r.hydrating && detectHandoffToken(joined)) r.onHandoffReady?.();
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
      touched = true;
      break;
    }
    case "tool_use": {
      // AUQ becomes a visual turn-splitter (question card) instead of a chip.
      // Only top-level AUQ calls get the card treatment; nested subagent calls
      // fall through to the normal chip path.
      if (ev.tool_name === "AskUserQuestion" && !ev.parent_tool_use_id) {
        r.auqPendingResult = true;
        // Save the streaming slot's current text before enqueueTurnClose zeros
        // it. The suppression branch uses this to tell apart the protocol
        // re-emit (same text → suppress) from real post-AUQ content delivered
        // by the file watcher while auqPendingResult is still true.
        if (r.streamingIndex !== null) {
          const existing = r.messages[r.streamingIndex] as RenderedMessage;
          r.auqPreContent = blocksToText(existing.content ?? []);
        } else {
          r.auqPreContent = null;
        }
        enqueueTurnClose(r);
        r.messages.push({
          kind: "question",
          tool: "AskUserQuestion",
          input: ev.input,
          id: ev.id,
          ts,
          parentToolUseId: null,
        });
        // Open a fresh sub-turn for post-question chips.
        r.activeTurnChipKey = ++r._chipKeySeq;
        r.activeTurnStart = r.messages.length;
        r.activeTurnStreamedText = "";
        r.activeTurnStartedAtMs = Date.now();
        r.activeTurnUsage = null;
        r.activeTurnFirstTs = ts > 0 ? ts : 0;
        r.activeTurnLastTs = r.activeTurnFirstTs;
        r.turnTodosBaseline = null;
        r.activityToolCanon = null;
        r.setActivity("Waiting for your answer…");
        touched = true;
        break;
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
        touched = true;
        break;
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
      touched = true;
      break;
    }
    case "tool_result": {
      // TodoWrite's tool_result carries no user-facing content - absorb it
      // silently (no message row, no tool tally bump), mirroring how the AUQ
      // branch below absorbs its own result but simpler: no card to update.
      if (r._todoWriteToolUseIds.delete(ev.tool_use_id)) { touched = true; break; }
      // If this result is the answer to an AUQ question card, absorb it into
      // the card (update its text and dirty-flag for re-render) instead of
      // adding a raw tool_result row. The fire-and-forget PreToolUse deny
      // (permission.rs's ASK_FIRE_AND_FORGET_REASON) always fires an is_error
      // tool_result right after the tool_use - a handshake, never the real
      // answer. Absorb it silently but leave `.text` undefined so the card
      // still reads "awaiting answer" and resolvePendingQuestionCard can find
      // it later when the real answer lands as a follow-up <auq-answer/>
      // message; setting `.text` here would poison both.
      const qIdx = r.messages.findIndex(
        (m) => m.kind === "question" && m.id === ev.tool_use_id,
      );
      if (qIdx >= 0) {
        if (!ev.is_error) {
          const ansText = ev.output?.type === "text" ? ev.output.text : "";
          r.messages[qIdx] = { ...r.messages[qIdx]!, text: ansText };
          r.dirtyIndices.add(qIdx);
        }
        r.onToolTally?.(r.tallyState.build());
        touched = true;
        break;
      }
      r.messages.push({
        kind: "tool_result",
        tool_use_id: ev.tool_use_id,
        output: ev.output,
        is_error: ev.is_error,
        ts,
      });
      // The tally counts didn't change, but a result can complete a custom
      // view (e.g. an AskUserQuestion answer): nudge the statusline so an open
      // popover re-renders from the now-updated messages.
      r.onToolTally?.(r.tallyState.build());
      touched = true;
      break;
    }
    case "notification":
      r.messages.push({ kind: "notification", text: ev.body, ts: Date.now() });
      touched = true;
      break;
    case "session_ended":
      enqueueTurnClose(r);
      r.messages.push({
        kind: "system",
        text: `Session ended${ev.exit_code !== null ? ` (exit ${ev.exit_code})` : ""}`,
        ts,
      });
      touched = true;
      break;
    case "turn_usage": {
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
        }
      }
      if (!opts.silent) {
        // turn_usage is a settle event (the meta row locking in its final
        // numbers) - flush now, bypassing scheduleFlush's throttle, so it's
        // never delayed behind a coalescing window opened by prior deltas.
        flushRenderNow(r);
      }
      return;
    }
    default:
      break;
  }
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
