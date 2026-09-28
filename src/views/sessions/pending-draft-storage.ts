import type { PendingNewSession, ParkedDraft } from "./state";

export const PENDING_SESSION_KEY = "pending-session:v1";
export const PARKED_DRAFTS_KEY = "parked-drafts:v1";

// Matches sent-outbox.ts's MAX_ENTRIES precedent: deep enough that a real
// pile of abandoned drafts survives, bounded so localStorage can't grow
// forever off never-resumed rows.
const MAX_PARKED_DRAFTS = 20;

export function savePendingSession(pending: PendingNewSession): void {
  try {
    const serialized = {
      placeholderId: pending.placeholderId,
      projectPath: pending.projectPath,
      projectName: pending.projectName,
      config: pending.config,
      realId: pending.realId,
      firstMessageSent: pending.firstMessageSent,
      preExistingSessionIds: Array.from(pending.preExistingSessionIds),
      firstMessageSentAt: pending.firstMessageSentAt,
    };
    localStorage.setItem(PENDING_SESSION_KEY, JSON.stringify(serialized));
  } catch {
    /* quota or storage disabled */
  }
}

export function loadPendingSession(): PendingNewSession | null {
  try {
    const raw = localStorage.getItem(PENDING_SESSION_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return {
      placeholderId: obj.placeholderId,
      projectPath: obj.projectPath,
      projectName: obj.projectName,
      config: obj.config,
      realId: obj.realId,
      firstMessageSent: obj.firstMessageSent,
      preExistingSessionIds: new Set(obj.preExistingSessionIds),
      firstMessageSentAt: obj.firstMessageSentAt ?? null,
    };
  } catch {
    return null;
  }
}

export function clearPendingSession(): void {
  try {
    localStorage.removeItem(PENDING_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Persists only the metadata needed to rebuild a parked-draft sidebar row.
 *  The typed text itself already lives under composer-persistence's
 *  `chat-draft:v1:<placeholderId>` key - this is deliberately not a second
 *  copy of it. */
export function saveParkedDrafts(list: ParkedDraft[]): void {
  try {
    if (list.length === 0) {
      localStorage.removeItem(PARKED_DRAFTS_KEY);
      return;
    }
    localStorage.setItem(PARKED_DRAFTS_KEY, JSON.stringify(list.slice(-MAX_PARKED_DRAFTS)));
  } catch {
    /* quota or storage disabled */
  }
}

export function loadParkedDrafts(): ParkedDraft[] {
  try {
    const raw = localStorage.getItem(PARKED_DRAFTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is ParkedDraft =>
        !!d &&
        typeof d.placeholderId === "string" &&
        typeof d.projectPath === "string" &&
        typeof d.projectName === "string" &&
        d.config != null,
    );
  } catch {
    return [];
  }
}
