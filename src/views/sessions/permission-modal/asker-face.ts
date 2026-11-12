// Who a card says it comes from (design C5): a sub by its avatar, the
// main chat by a "Main chat" chip, so Joe never has to ask "what chat is this?".

import { state } from "../state";
import { displayIdOf, isSubchatsOn } from "./gating";
import type { AskerFace, QuestionRequestedPayload } from "./types";

export const MAIN_CHAT_LABEL = "Main chat";

/** The routing fields every prompt payload carries, plus the two a daemon card adds. */
type FaceSource = Pick<QuestionRequestedPayload, "session_id" | "display_session_id" | "sub_name" | "sub_task" | "sub_id" | "daemon_card">;

function subFace(subId: string, name: string | undefined, task: string | undefined): AskerFace {
  const row = state.sessions.find((s) => s.session_id === subId);
  return {
    name: name || row?.name?.trim() || "Subchat",
    ...(task ? { task } : {}),
    ...(row?.model ? { model: row.model } : {}),
    ...(row?.effort ? { effort: row.effort } : {}),
  };
}

/** The face for a card, or undefined when it needs none:
 *  - a hidden sub's own card (shown in its main chat's window): that sub;
 *  - a card the daemon raised about a sub (stopped, stuck, close): that sub;
 *  - the main chat's own question, permission or secret: "Main chat";
 *  - a plain chat, or a daemon card about no sub: nothing, since there is no other
 *    chat it could be mistaken for. */
export function askerFaceOf(payload: FaceSource): AskerFace | undefined {
  const shownOn = displayIdOf(payload);
  const asker = payload.session_id;
  if (shownOn && asker && shownOn !== asker) return subFace(asker, payload.sub_name, payload.sub_task);
  if (payload.daemon_card) return payload.sub_id ? subFace(payload.sub_id, payload.sub_name, payload.sub_task) : undefined;
  if (asker && isSubchatsOn(asker)) return { name: MAIN_CHAT_LABEL, main: true };
  return undefined;
}
