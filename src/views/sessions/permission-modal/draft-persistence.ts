import type { QuestionDraft, Selection } from "./types";

// Mirrors shared/chat/composer-persistence.ts's shape: a versioned localStorage
// key per id, survives a full app restart. Keyed by prompt id (not session id)
// since a prompt id is what respond_question/prompt-resolved already correlate
// on, and a session can only ever have one live AUQ prompt at a time.
const DRAFT_PREFIX = "auq-draft:v1:";

function draftKey(promptId: string): string {
  return DRAFT_PREFIX + promptId;
}

// JSON has no Map/Set - selections serialize as [index, label[]] (multiSelect)
// or [index, label] (single-select), freeText as [index, text][]. Attachments
// carry path+mime+filename+size only, never base64 - keeps both localStorage
// and the debounced daemon push cheap; attachments.ts re-fetches bytes on demand.
interface StoredAttachment {
  mime: string;
  path: string;
  filename: string;
  size: number;
}

interface StoredDraft {
  freeText: [number, string][];
  selections: [number, string | string[]][];
  activeTab: number;
  additionalMessage?: string;
  attachments?: StoredAttachment[];
  /** Stamped by saveQuestionDraft, absent on a pre-migration entry (treated
   *  as older than any timestamped source - see loadQuestionDraftMeta). */
  updatedAt?: string;
}

/** The same shape localStorage stores, reused as-is for the daemon's opaque
 *  `set_auq_draft` payload blob so both stores round-trip identically. */
export function serializeQuestionDraft(draft: QuestionDraft): unknown {
  const stored: StoredDraft = {
    freeText: Array.from(draft.freeText.entries()),
    selections: Array.from(draft.selections.entries()).map(([k, v]) => [k, v instanceof Set ? Array.from(v) : v]),
    activeTab: draft.activeTab,
    additionalMessage: draft.additionalMessage || undefined,
    attachments: (draft.attachments ?? [])
      .filter((a): a is typeof a & { path: string } => Boolean(a.path))
      .map((a) => ({ mime: a.mime, path: a.path, filename: a.filename, size: a.size })),
  };
  return stored;
}

export function deserializeQuestionDraft(payload: unknown): QuestionDraft | null {
  const parsed = payload as StoredDraft | null | undefined;
  if (!parsed || !Array.isArray(parsed.freeText) || !Array.isArray(parsed.selections)) return null;
  const attachments = Array.isArray(parsed.attachments)
    ? parsed.attachments
        .filter((a) => a && typeof a.path === "string" && typeof a.mime === "string")
        .map((a) => ({ mime: a.mime, path: a.path, filename: a.filename ?? a.path, size: a.size ?? 0, data: "" }))
    : [];
  return {
    freeText: new Map(parsed.freeText),
    selections: new Map<number, Selection>(
      parsed.selections.map(([k, v]) => [k, Array.isArray(v) ? new Set(v) : v])
    ),
    activeTab: typeof parsed.activeTab === "number" ? parsed.activeTab : 0,
    additionalMessage: typeof parsed.additionalMessage === "string" ? parsed.additionalMessage : "",
    attachments,
  };
}

/** Draft plus its local save time, for reconciling against the daemon's
 *  `updated_at` (see auq-draft-sync.ts's fetchFreshestAuqDraft) - the
 *  reload-precedence fix needs to compare timestamps, not just presence. */
export function loadQuestionDraftMeta(promptId: string): { draft: QuestionDraft; updatedAt: string | null } | null {
  try {
    const raw = localStorage.getItem(draftKey(promptId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    const draft = deserializeQuestionDraft(parsed);
    if (!draft) return null;
    return { draft, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null };
  } catch {
    return null;
  }
}

export function saveQuestionDraft(promptId: string, draft: QuestionDraft): void {
  try {
    const stored = serializeQuestionDraft(draft) as StoredDraft;
    stored.updatedAt = new Date().toISOString();
    localStorage.setItem(draftKey(promptId), JSON.stringify(stored));
  } catch {
    /* quota or storage disabled - lose the draft, don't crash */
  }
}

export function clearQuestionDraft(promptId: string): void {
  try {
    localStorage.removeItem(draftKey(promptId));
  } catch {
    /* ignore */
  }
}
