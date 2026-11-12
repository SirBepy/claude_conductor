import { invoke } from "../../shared/ipc";
import { isSessionBusyError } from "../../shared/session-busy";
import { apiCreditBlockedReason, sendFailureText } from "../../shared/api-credit-blocked";
import { sessionEvents } from "../../shared/chat/event-store";
import { bundleHeld } from "../../shared/chat/held-messages";
import { showToast } from "../../shared/toast";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";
import { state } from "./state";

/** Ids of messages the daemon refused as mid-turn and the held queue now
 *  carries, keyed by session and message. The held flush sends them through
 *  this same function, which takes the id back so the second delivery is the
 *  same message to the PC (its dedupe keys on the id). In memory on purpose: a
 *  reload loses it and the message then goes out under a new id, which only
 *  costs the dedupe for a copy already in flight at that moment. */
const heldSendIds = new Map<string, string>();
const HELD_SEND_IDS_MAX = 100;

/** What a held flush sends for exactly one queued item (`bundleHeld` is what
 *  the flush runs); two items or a draft merged in change the text, so they
 *  are a different message and miss. */
function heldKey(sessionId: string, blocks: ContentBlock[]): string {
  return `${sessionId}\u0000${JSON.stringify(bundleHeld([blocks]))}`;
}

/** randomUUID exists only in a secure context; a phone page served over plain
 *  http on the LAN still needs an id. */
function newClientMsgId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function rememberHeldSendId(sessionId: string, blocks: ContentBlock[], id: string): void {
  heldSendIds.set(heldKey(sessionId, blocks), id);
  if (heldSendIds.size > HELD_SEND_IDS_MAX) {
    const oldest = heldSendIds.keys().next().value;
    if (oldest !== undefined) heldSendIds.delete(oldest);
  }
}

function takeHeldSendId(sessionId: string, blocks: ContentBlock[]): string | undefined {
  const key = heldKey(sessionId, blocks);
  const id = heldSendIds.get(key);
  heldSendIds.delete(key);
  return id;
}

/** Shared "retryable send + catch + mark the bubble failed" path (ai_todo 800),
 * used by the established composer and both pending-pane send sites so the
 * failed-send policy lives in one place instead of drifting copies. Resolves
 * true when the message went out or was held for the chat's turn end, false
 * when it failed (already marked and toasted here). */
export async function sendWithFailureRecovery(
  sessionId: string,
  cwd: string,
  blocks: ContentBlock[],
  optimisticEvent: ChatEvent,
): Promise<boolean> {
  // One id for this message across the transport's own retry, the Retry
  // button below and a held-queue re-stage. The desktop's Tauri command reads
  // only the keys it declares, so the extra key is ignored there.
  const clientMsgId = takeHeldSendId(sessionId, blocks) ?? newClientMsgId();
  const attempt = (): Promise<void> => invoke<void>("send_message", { sessionId, cwd, blocks, clientMsgId });
  try {
    await attempt();
    return true;
  } catch (err) {
    // Refused mid-turn (todo 873): the same outcome as the composer's own busy
    // check, decided one race later. Queue the blocks and drop the optimistic
    // bubble the held chip now stands for - a failed-send bubble would be a lie.
    if (isSessionBusyError(err) && state.heldMessages?.stageFor(sessionId, blocks)) {
      rememberHeldSendId(sessionId, blocks, clientMsgId);
      sessionEvents.removeSynthetic(sessionId, optimisticEvent);
      if (state.renderer?.currentSessionId() === sessionId) void state.renderer.loadFromStore(cwd);
      return true;
    }
    // An API-credit refusal is an expected stop, not a fault: it is never
    // queued (nothing frees the credit by waiting for the turn to end), and it
    // reads as the bare reason instead of "Send failed: rpc error: ...".
    const blockedReason = apiCreditBlockedReason(err);
    if (blockedReason === null) console.error("[sessions] send_message failed", err);
    const onScreen = state.renderer?.currentSessionId() === sessionId;
    if (onScreen) {
      // Keep the optimistic bubble and mark it: after clearComposer() it is
      // the only surviving copy of what the user typed, and Retry re-sends
      // exactly these blocks. A toast alone loses the text on dismiss.
      state.renderer?.markLastUserSendFailed(sendFailureText(err), attempt);
    } else {
      // Nothing on screen to mark, so the bubble would just linger looking
      // sent. Roll it back; sent-outbox.ts still holds the text for Ctrl+Z.
      sessionEvents.removeSynthetic(sessionId, optimisticEvent);
    }
    showToast(blockedReason ?? `Send failed: ${err}`);
    return false;
  }
}
