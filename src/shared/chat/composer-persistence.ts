import { clearComposerDraft } from "./session-draft-sync";
import { clearSentOutbox, moveSentOutbox } from "./sent-outbox";

const DRAFT_PREFIX = "chat-draft:v1:";

function draftKey(sessionId: string): string {
  return DRAFT_PREFIX + sessionId;
}

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(sessionId: string, text: string): void {
  try {
    localStorage.setItem(draftKey(sessionId), text);
  } catch {
    /* quota or storage disabled - lose the draft, don't crash */
  }
}

export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(draftKey(sessionId));
  } catch {
    /* ignore */
  }
}

// The server `updated_at` this device last knows the daemon holds, persisted
// beside the draft so a reload compares real timestamps instead of
// defaulting to "remote wins".
const SYNC_BASELINE_PREFIX = "chat-draft-sync:v1:";

function syncBaselineKey(sessionId: string): string {
  return SYNC_BASELINE_PREFIX + sessionId;
}

export function loadSyncBaseline(sessionId: string): string | null {
  try {
    return localStorage.getItem(syncBaselineKey(sessionId));
  } catch {
    return null;
  }
}

export function saveSyncBaseline(sessionId: string, updatedAt: string): void {
  try {
    localStorage.setItem(syncBaselineKey(sessionId), updatedAt);
  } catch {
    /* quota or storage disabled - the in-memory Map still tracks it */
  }
}

// ── Attachment metadata persistence ────────────────────────────────────────
//
// Only paths + mime + filename are stored, not the base64 bytes - those are
// re-read from disk via the `read_attachment` IPC on restore. Keeps LS small
// and avoids hitting the 5-10MB quota when a draft has several screenshots.
const ATT_PREFIX = "chat-att:v1:";

export interface AttachmentMeta { path: string; mime: string; filename: string; }

function attKey(sessionId: string): string {
  return ATT_PREFIX + sessionId;
}

export function loadAttachmentsMeta(sessionId: string): AttachmentMeta[] {
  try {
    const raw = localStorage.getItem(attKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is AttachmentMeta =>
      m && typeof m.path === "string" && typeof m.mime === "string" && typeof m.filename === "string"
    );
  } catch {
    return [];
  }
}

export function saveAttachmentsMeta(sessionId: string, metas: AttachmentMeta[]): void {
  try {
    localStorage.setItem(attKey(sessionId), JSON.stringify(metas));
  } catch {
    /* quota or storage disabled - lose the meta, don't crash */
  }
}

export function clearAttachmentsMeta(sessionId: string): void {
  try {
    localStorage.removeItem(attKey(sessionId));
  } catch {
    /* ignore */
  }
}

/** External callers (sidebar park/discard, pending-flow discard) can clean
 *  up draft localStorage for a session id whose composer is gone. */
export function discardComposerDraft(sessionId: string): void {
  clearDraft(sessionId);
  clearAttachmentsMeta(sessionId);
  clearSentOutbox(sessionId);
  void clearComposerDraft(sessionId).catch((e) => console.warn("[composer-sync] discard clear failed:", e));
}

/** Move a stored draft from one session id to another. Used when a parked
 *  draft is resumed under a fresh placeholderId so the user keeps their text. */
export function moveComposerDraft(fromId: string, toId: string): void {
  const text = loadDraft(fromId);
  if (text) saveDraft(toId, text);
  clearDraft(fromId);
  const metas = loadAttachmentsMeta(fromId);
  if (metas.length) saveAttachmentsMeta(toId, metas);
  clearAttachmentsMeta(fromId);
  moveSentOutbox(fromId, toId);
}
