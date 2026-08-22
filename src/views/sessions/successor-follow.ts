// Split out of sessions-wiring.ts (transport/DOM graph) to stay testable.

import type { Instance } from "../../types/ipc.generated";

const followed = new Set<string>();

/** `respawn` spawns a successor and closes the caller, so a fresh context
 *  window means a fresh id. Following the link is what stops that reading as
 *  "my chat vanished". */
export function findSuccessorToFollow(
  sessions: readonly Instance[],
  selectedId: string | null,
): string | null {
  if (!selectedId || followed.has(selectedId)) return null;
  const successor = sessions.find(
    (s) => s.successor_of === selectedId && !s.ended_at && s.session_id !== selectedId,
  );
  return successor ? successor.session_id : null;
}

/** A predecessor stays live until its own turn ends, so re-selecting it must
 *  not yank the user forward a second time. */
export function markFollowed(predecessorId: string): void {
  followed.add(predecessorId);
}

export function resetFollowed(): void {
  followed.clear();
}
