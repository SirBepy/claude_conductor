// Event dispatch for ChatRenderer (ai_todo 123). The per-event live dispatch
// state machine (handleChatEvent), split out of chat-renderer.ts. The history
// bulk replay (bulkLoadEvents) lives in chat-event-bulk-load.ts (ai_todo 314).
// Free functions taking the renderer `r`, sharing its instance state with
// chat-dom-renderer.ts; behavior is byte-identical to the pre-split methods.

import type { ChatEvent } from "../../types/ipc.generated";
import { scrollToBottom, isNearBottom } from "./chat-dom-renderer";
import { scheduleFlush, flushRenderNow } from "./flush-scheduler";
import type { ChatRenderer } from "./chat-renderer";
import { handleToolUseEvent, handleToolResultEvent } from "./chat-event-handler-tools";
import {
  handleSessionStartedEvent,
  handleNotificationEvent,
  handleSessionEndedEvent,
  handleTurnUsageEvent,
} from "./chat-event-handler-lifecycle";
import {
  handleUserMessageEvent,
  handleAssistantMessageEvent,
} from "./chat-event-handler-messages";

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

export function handleChatEvent(r: ChatRenderer, ev: ChatEvent, opts: HandleEventOpts = {}): void {
  const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
  // Capture before mutating: if the user had scrolled up to read history, we
  // preserve their position instead of yanking them to the bottom on a live
  // update. Sending a user_message leaves them at the bottom anyway, so the
  // gate naturally re-engages auto-scroll for their own messages.
  const wasAtBottom = isNearBottom(r);
  if (!opts.silent) r.onLiveEvent?.();
  let outcome: EventOutcome = { touched: false, coalesce: false };
  switch (ev.type) {
    case "session_started": outcome = handleSessionStartedEvent(r, ev, ts); break;
    case "user_message": outcome = handleUserMessageEvent(r, ev, ts); break;
    case "assistant_message": outcome = handleAssistantMessageEvent(r, ev, ts); break;
    case "tool_use": outcome = handleToolUseEvent(r, ev, ts); break;
    case "tool_result": outcome = handleToolResultEvent(r, ev); break;
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
