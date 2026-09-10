// Session/usage lifecycle handlers (session_started, session_ended,
// notification, turn_usage) split out of chat-event-handler.ts (ai_todo 912):
// the fifth regrowth past the size rule, same seam as the tool-lifecycle
// split (ai_todo 746). handleChatEvent still dispatches into these exactly as
// before; behavior is byte-identical to the pre-split code.

import type { ChatEvent } from "../../types/ipc.generated";
import { finalizeStreamingBubble } from "./chat-dom-renderer";
import {
  enqueueTurnClose,
  ensureActiveTurnFooter,
  activeTurnTsSpan,
  clearRunningHighlight,
} from "./chat-turn-fold";
import { flushRenderNow } from "./flush-scheduler";
import { applyWaitingOnNotification } from "./turn-chips";
import { tryHandleQuestionSkipped } from "./chat-question-card";
import type { ChatRenderer } from "./chat-renderer";
import type { HandleEventOpts } from "./chat-event-handler";

// Structurally identical to chat-event-handler.ts's own (unexported)
// EventOutcome - duplicated rather than exported so this split adds no new
// export surface to that file (mirrors chat-event-handler-tools.ts's own note).
interface EventOutcome {
  touched: boolean;
  coalesce: boolean;
}

export function handleSessionStartedEvent(
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

export function handleNotificationEvent(r: ChatRenderer, ev: Extract<ChatEvent, { type: "notification" }>): EventOutcome {
  if (tryHandleQuestionSkipped(r, ev)) return { touched: true, coalesce: false };
  // todo 675: the waiting-on target rides a generic Notification (not its own
  // ChatEvent variant - types/chat.rs is owned elsewhere right now). It only
  // updates the current turn's footer chip, never a message row.
  if (ev.kind === "waiting_on") {
    applyWaitingOnNotification(r.turnFooters, r.activeTurnChipKey, ev.body);
    return { touched: true, coalesce: false };
  }
  // The CLI retries a 529/overloaded response on its own with no chat-visible
  // error, so without this the turn just sits on "thinking..." indefinitely.
  // Quiet affordance, not a message row - same thinking-bar text the tool
  // activity and AUQ-waiting cases already use.
  if (ev.kind === "api_retry") {
    r.setActivity(ev.body ? `Retrying, hit a server error (${ev.body})…` : "Retrying, hit a server error…");
    return { touched: true, coalesce: false };
  }
  r.messages.push({ kind: "notification", text: ev.body, ts: Date.now() });
  return { touched: true, coalesce: false };
}

export function handleSessionEndedEvent(
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
export function handleTurnUsageEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "turn_usage" }>,
  opts: HandleEventOpts,
): void {
  // A live turn whose `result` line carries no text (it ended on a tool call)
  // emits NO finalized assistant_message, so this is the only turn-end event
  // the streamed bubble ever sees - without this it streams forever (todo 719).
  finalizeStreamingBubble(r);
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
