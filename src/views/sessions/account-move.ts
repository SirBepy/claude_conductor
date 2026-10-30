// The move-announce-follow sequence shared by the established pane's account
// chip (active-session-account.ts) and the draft pane's held pick
// (pending-pane-spawn.ts). The rate-limit banner has its own toast ("continuing")
// and no failure toast, so it keeps its own copy.

import { api } from "../../shared/api";
import { showToast } from "../../shared/toast";
import { capitalize } from "../../shared/chat/rate-limit-banner";

/** Move `sessionId` to `pickedId`, toast "Now on <name>.", then run `follow`
 *  with the session's post-move id. `follow` is a callback, not a direct call
 *  to applyAccountMove, so each caller keeps its own import timing:
 *  active-session-account.ts owns applyAccountMove, and the draft pane reaches
 *  it dynamically because active-session.ts sits above it in the import graph.
 *  The whole sequence sits in one try, so a failing `follow` surfaces as the
 *  failure toast instead of escaping into a caller that is mid-rollback. */
export async function moveChatToAccount(
  sessionId: string,
  pickedId: string,
  name: string,
  follow: (newId: string) => Promise<void>,
): Promise<void> {
  try {
    const newId = await api.moveSessionToAccount(sessionId, pickedId);
    showToast(`Now on ${capitalize(name)}.`);
    await follow(newId);
  } catch (e) {
    console.error("[account-move] change account failed", e);
    showToast("Failed to move chat to that account.");
  }
}
