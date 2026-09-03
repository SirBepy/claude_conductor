import { invoke } from "../../shared/ipc";
import { isSessionBusyError } from "../../shared/session-busy";
import { sessionEvents } from "../../shared/chat/event-store";
import { showToast } from "../../shared/toast";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";
import { state } from "./state";

/** Shared "retryable send + catch + mark the bubble failed" path (ai_todo 800),
 * used by the established composer and both pending-pane send sites so the
 * failed-send policy lives in one place instead of drifting copies. */
export async function sendWithFailureRecovery(
  sessionId: string,
  cwd: string,
  blocks: ContentBlock[],
  optimisticEvent: ChatEvent,
): Promise<void> {
  const attempt = (): Promise<void> => invoke<void>("send_message", { sessionId, cwd, blocks });
  try {
    await attempt();
  } catch (err) {
    // Refused mid-turn (todo 873): the same outcome as the composer's own busy
    // check, decided one race later. Queue the blocks and drop the optimistic
    // bubble the held chip now stands for - a failed-send bubble would be a lie.
    if (isSessionBusyError(err) && state.heldMessages?.stageFor(sessionId, blocks)) {
      sessionEvents.removeSynthetic(sessionId, optimisticEvent);
      if (state.renderer?.currentSessionId() === sessionId) void state.renderer.loadFromStore(cwd);
      return;
    }
    console.error("[sessions] send_message failed", err);
    const onScreen = state.renderer?.currentSessionId() === sessionId;
    if (onScreen) {
      // Keep the optimistic bubble and mark it: after clearComposer() it is
      // the only surviving copy of what the user typed, and Retry re-sends
      // exactly these blocks. A toast alone loses the text on dismiss.
      state.renderer?.markLastUserSendFailed(String(err), attempt);
    } else {
      // Nothing on screen to mark, so the bubble would just linger looking
      // sent. Roll it back; sent-outbox.ts still holds the text for Ctrl+Z.
      sessionEvents.removeSynthetic(sessionId, optimisticEvent);
    }
    showToast(`Send failed: ${err}`);
  }
}
