// A new-chat draft's start_session window: the pick made while the spawn is
// pending is held here and applied as a move once the session id arrives.
// Split out of pending-pane-mount.ts; the composer (begin/end) and the draft's
// account chip (changePendingAccount) are the two sides of it.

import { getCachedAccount } from "../../shared/chat/rate-limit-banner";
import { moveChatToAccount } from "./account-move";

/** Drafts whose start_session is awaiting its session id, by placeholder id.
 *  The renderer only swaps to the real id after that resolves, so
 *  `currentSessionId() === placeholderId` alone cannot tell "not sent yet"
 *  from "sent, id pending". */
const spawnsInFlight = new Map<string, {
  /** The account the spawn took (config.accountId when it began). */
  spawnedAccountId: string | null;
  /** The newest pick made while the spawn was pending; applied as a move. */
  pick: { id: string; label: string | null } | null;
}>();

/** The in-flight spawn for a draft, or undefined once start_session settled. */
export function draftSpawnInFlight(placeholderId: string) {
  return spawnsInFlight.get(placeholderId);
}

/** Call right before start_session so a pick made during it is tracked. */
export function beginDraftSpawn(placeholderId: string, spawnedAccountId: string | null): void {
  spawnsInFlight.set(placeholderId, { spawnedAccountId, pick: null });
}

/** Call once start_session settles. Returns the pick held during it, if any;
 *  on success the caller moves the new chat there, on failure it drops it. */
export function endDraftSpawn(placeholderId: string): { id: string; label: string | null } | null {
  const flight = spawnsInFlight.get(placeholderId);
  spawnsInFlight.delete(placeholderId);
  return flight?.pick ?? null;
}

/** Move an already-spawned chat to `pickedId` and follow it to its new id.
 *  `label` is looked up by the caller in the list the pick came from: a
 *  peer-hosted chat's account ids exist only in that peer's list, so the local
 *  cache would read a peer account as "the other account". Never throws: the
 *  composer calls this from inside the try that rolls back a failed spawn, and
 *  the chat has already spawned by then. */
export async function moveSpawnedChat(
  sessionId: string,
  pickedId: string,
  label: string | null,
  machineAimed: boolean,
): Promise<void> {
  const name = label ?? (machineAimed ? null : getCachedAccount(pickedId)?.label) ?? "the other account";
  await moveChatToAccount(sessionId, pickedId, name, async (newId) => {
    // Dynamic: active-session.ts sits above this module in the import graph.
    const [{ selectSession }, { applyAccountMove }] = await Promise.all([
      import("./active-session"),
      import("./active-session-account"),
    ]);
    await applyAccountMove(sessionId, newId, selectSession);
  });
}
