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
  rowKeyById.clear();
}

/** Row key per session id, for ids that inherited one. */
const rowKeyById = new Map<string, string>();

/** The reconciler's identity for a session's row. A successor answers with its
 *  predecessor's key, so the list updates one `<li>` in place. */
export function chainRowKey(sessionId: string): string {
  return rowKeyById.get(sessionId) ?? `s:${sessionId}`;
}

/** Hand every successor its predecessor's row key. Runs on every refresh: the
 *  key has to survive the predecessor dropping out of the list. */
export function recordChainLinks(sessions: readonly Instance[]): void {
  for (const s of sessions) {
    if (!s.successor_of || rowKeyById.has(s.session_id)) continue;
    rowKeyById.set(s.session_id, chainRowKey(s.successor_of));
  }
}

/** Predecessors a live successor has taken over from. Both still run, but
 *  rendering both is the "two chats, then one vanishes" flicker. */
export function supersededPredecessors(sessions: readonly Instance[]): Set<string> {
  const superseded = new Set<string>();
  for (const s of sessions) {
    if (s.successor_of && !s.ended_at) superseded.add(s.successor_of);
  }
  return superseded;
}
