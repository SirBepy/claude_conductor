// "Busy? stage it; held queue already has items? flush with it; else hand off
// to the caller's own send" for side-channel senders (Revise menu, Preview
// reply box). The send itself stays with each caller because their failure
// recovery differs: Revise marks the on-screen bubble failed, Preview restores
// the typed text into its reply box.

import type { ContentBlock } from "../../types/ipc.generated";
import { isCurrentSessionBusy } from "./session-thinking-bar";
import { state } from "./state";

export type SendOrStageResult = "staged" | "flushed" | "sent";

/** `checkActive` gates the busy/held checks: both are keyed off the
 *  on-screen/"active" session (`isCurrentSessionBusy`, `hasItemsForActive`),
 *  so a caller whose target session is not on screen must pass `false` or
 *  the checks would answer for the wrong chat. Defaults to true. */
export interface SendOrStageOptions {
  checkActive?: boolean;
}

/** Runs the shared policy, then `send()` for the final "else" branch. */
export async function sendOrStage(
  blocks: ContentBlock[],
  send: () => void | Promise<void>,
  options: SendOrStageOptions = {},
): Promise<SendOrStageResult> {
  const checkActive = options.checkActive ?? true;
  if (checkActive && isCurrentSessionBusy()) {
    state.heldMessages?.stage(blocks);
    return "staged";
  }
  if (checkActive && state.heldMessages?.hasItemsForActive()) {
    state.heldMessages.flushHeldWithDraft(blocks).catch((err) => {
      console.error("[send-or-stage] flushHeldWithDraft rejected unexpectedly", err);
    });
    return "flushed";
  }
  await send();
  return "sent";
}
