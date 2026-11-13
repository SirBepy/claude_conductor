// The move-announce-follow sequence shared by the established pane's account
// chip (active-session-account.ts) and the draft pane's held pick
// (pending-pane-spawn.ts). The rate-limit banner opens the same picker through
// active-session-account.ts, so it lands here too.

import { api } from "../../shared/api";
import { showToast } from "../../shared/toast";
import { capitalize } from "../../shared/chat/rate-limit-banner";
import type { Instance } from "../../types/ipc.generated";

/** The subs one "Also move its subchats" carries: every sub of `mainId` that
 *  is not ended. A finished sub wakes on a follow-up, so it moves too. */
export function movableSubs(mainId: string, sessions: readonly Instance[]): Instance[] {
  return sessions.filter((s) => s.subchat_of === mainId && !s.ended_at && !s.end_reason);
}

/** What one pick moves: the chat itself unless it already runs on `pickedId`,
 *  and with `withSubs` each sub not on it yet. */
export function planAccountMove(
  chat: Instance,
  sessions: readonly Instance[],
  pickedId: string,
  withSubs: boolean,
): { moveChat: boolean; subIds: string[] } {
  const subIds = withSubs
    ? movableSubs(chat.session_id, sessions).filter((s) => s.account_id !== pickedId).map((s) => s.session_id)
    : [];
  return { moveChat: chat.account_id !== pickedId, subIds };
}

/** Move `sessionId` to `pickedId`, then each of `subIds`, toast the outcome,
 *  then run `follow` with the session's post-move id. Each move is the daemon's
 *  in-place swap, which restarts a working chat at once and sends "continue".
 *  `follow` is a callback, not a direct call to applyAccountMove, so each
 *  caller keeps its own import timing: active-session-account.ts owns
 *  applyAccountMove, and the draft pane reaches it dynamically because
 *  active-session.ts sits above it in the import graph. The chat's own move and
 *  `follow` sit in one try, so a failing `follow` surfaces as the failure toast
 *  instead of escaping into a caller that is mid-rollback; a sub that fails is
 *  counted and named in the toast without stopping the others. */
export async function moveChatToAccount(
  sessionId: string,
  pickedId: string,
  name: string,
  follow: (newId: string) => Promise<void>,
  plan: { moveChat: boolean; subIds: readonly string[] } = { moveChat: true, subIds: [] },
): Promise<void> {
  try {
    const newId = plan.moveChat ? await api.moveSessionToAccount(sessionId, pickedId) : sessionId;
    let failed = 0;
    for (const subId of plan.subIds) {
      try {
        await api.moveSessionToAccount(subId, pickedId);
      } catch (e) {
        failed++;
        console.error("[account-move] sub move failed", subId, e);
      }
    }
    showToast(moveToast(capitalize(name), plan.subIds.length, failed));
    await follow(newId);
  } catch (e) {
    console.error("[account-move] change account failed", e);
    // The daemon's API-credit refusal says what to do instead, so it is shown.
    const reason = e instanceof Error ? e.message : String(e);
    showToast(reason.includes("API-credit account") ? reason : "Failed to move chat to that account.");
  }
}

function moveToast(name: string, subs: number, failed: number): string {
  if (subs === 0) return `Now on ${name}.`;
  const moved = subs - failed;
  const word = (n: number) => `${n} subchat${n === 1 ? "" : "s"}`;
  if (failed === 0) return `Now on ${name}, with ${word(moved)}.`;
  if (moved === 0) return `Now on ${name}. ${word(failed)} failed to move.`;
  return `Now on ${name}, with ${word(moved)}. ${word(failed)} failed to move.`;
}
