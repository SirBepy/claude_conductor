// Reads one main chat's subs off the instance list into the Subchats card's
// items (shared/chat/dashboard/subs-model.ts). The state, progress words and
// ring come from the same functions the sidebar row and the header's sub list
// use (main-chat.ts, sub-list.ts), so a dot here and a dot there cannot disagree.

import type { Instance } from "../../../types/ipc.generated";
import type { SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import { mainChatInfo } from "../main-chat";
import { subRingSpec } from "../sub-list";

/** `finishedAt` is the main chat's finish-card times (fetchSubCards); a sub with
 *  none falls back to the row's last busy/idle flip, and one with neither is
 *  left undated (the card folds it). */
export function collectSubItems(
  mainId: string,
  sessions: readonly Instance[],
  finishedAt: ReadonlyMap<string, number>,
): SubCardItem[] {
  const main = sessions.find((s) => s.session_id === mainId);
  if (!main) return [];
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  return mainChatInfo(main, sessions).subs.map((sub) => {
    const inst = byId.get(sub.id);
    const flip = Date.parse(inst?.progress?.state_since ?? "");
    const finished = finishedAt.get(sub.id) ?? (Number.isNaN(flip) ? null : flip);
    return {
      id: sub.id,
      name: sub.name,
      kind: sub.kind,
      closing: sub.closing,
      model: inst?.model ?? "",
      effort: inst?.effort ?? "",
      progress: sub.progress,
      startedAt: inst?.started_at ?? null,
      finishedAt: sub.kind === "finished" ? finished : null,
      ring: subRingSpec(sub, inst),
    };
  });
}
