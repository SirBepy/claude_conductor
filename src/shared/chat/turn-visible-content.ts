// Own module because chat-event-handler.ts and chat-dom-renderer.ts already
// import each other, and both need this - a third edge would close the cycle.

import { blocksToText } from "./content-blocks";
import { isRawViewEnabled } from "./message-filter-pref";
import type { ChatRenderer } from "./chat-renderer";

/** True if the open turn has produced anything the user would see - real
 *  assistant text, send_message, a user/question row, or an interrupted
 *  notice. Tool calls/results and TodoWrite don't count. */
export function turnProducedVisibleContent(r: ChatRenderer): boolean {
  if (r.activeTurnStart === null) return false;
  for (let i = r.activeTurnStart; i < r.messages.length; i++) {
    const m = r.messages[i]!;
    switch (m.kind) {
      case "assistant":
        // Raw narration is hidden by default (chat-narration CSS, see
        // message-filter-pref.ts) - only counts as visible when the user has
        // the raw-chat toggle on for this session, else it wrongly blocks
        // the silent-streak merge.
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
