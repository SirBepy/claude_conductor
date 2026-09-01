import { invoke } from "../../shared/ipc";
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
