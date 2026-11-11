// The two warnings shown before a branch checkout, shared by Code mode's branch
// switcher and the command palette's Switch branch so both say the same words:
// uncommitted files ride along, and another Conductor session is live in the
// same repo.

import type { Instance } from "../../../types/ipc.generated";

export const PEER_SESSION_WARNING = "Another Conductor session is active in this repo";

export function dirtyWarning(count: number): string | null {
  return count > 0 ? `${count} uncommitted file${count === 1 ? "" : "s"} will come with you` : null;
}

export function peerSessionActive(instances: readonly Instance[], cwd: string, sessionId: string | null): boolean {
  return instances.some((i) => i.cwd === cwd && i.session_id !== sessionId && i.ended_at === null);
}

/** Peer warning first, then the dirty one, matching the switcher's order. */
export function branchWarnings(dirty: readonly string[], peerActive: boolean): string[] {
  const out: string[] = [];
  if (peerActive) out.push(PEER_SESSION_WARNING);
  const d = dirtyWarning(dirty.length);
  if (d) out.push(d);
  return out;
}
