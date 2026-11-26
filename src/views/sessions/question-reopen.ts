// Brings a pending question card back up by its id. Shared by the transcript's card (sessions.ts) and the
// dashboard Plan card's missed-question line (chat-dashboard.ts), so both answer a dead card the same way.

import { showToast } from "../../shared/toast";
import { reopenPendingPrompt } from "./permission-modal/resurface";

/** Puts the real, answerable card back up. When nothing can answer it any more it is cleared rather than
 *  left waiting on Joe, and a toast says which happened. */
export async function reopenQuestionCard(sessionId: string, cardId?: string): Promise<void> {
  if (await reopenPendingPrompt(sessionId, cardId)) return;
  if (cardId) {
    const { clearUnreopenableCard } = await import("./permission-modal/dismiss-open-questions");
    if (await clearUnreopenableCard(sessionId, cardId)) {
      showToast("This question can no longer be answered, so it was cleared.");
      return;
    }
  }
  showToast("This question can no longer be reopened.");
}
