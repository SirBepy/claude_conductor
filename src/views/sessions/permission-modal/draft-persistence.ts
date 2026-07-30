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
// are NOT stored here (base64 bytes are too heavy for localStorage, and unlike
// the composer's own attachments there's no path-only rehydration path for
// this card) - a full app restart loses staged images, same as it already
// loses everything else the card can't cheaply serialize.
interface StoredDraft {
  freeText: [number, string][];
  selections: [number, string | string[]][];
  activeTab: number;
  additionalMessage?: string;
}

export function loadQuestionDraft(promptId: string): QuestionDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(promptId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!Array.isArray(parsed.freeText) || !Array.isArray(parsed.selections)) return null;
    return {
      freeText: new Map(parsed.freeText),
      selections: new Map<number, Selection>(
        parsed.selections.map(([k, v]) => [k, Array.isArray(v) ? new Set(v) : v])
      ),
      activeTab: typeof parsed.activeTab === "number" ? parsed.activeTab : 0,
      additionalMessage: typeof parsed.additionalMessage === "string" ? parsed.additionalMessage : "",
      attachments: [],
    };
  } catch {
    return null;
  }
}

export function saveQuestionDraft(promptId: string, draft: QuestionDraft): void {
  try {
    const stored: StoredDraft = {
      freeText: Array.from(draft.freeText.entries()),
      selections: Array.from(draft.selections.entries()).map(([k, v]) => [k, v instanceof Set ? Array.from(v) : v]),
      activeTab: draft.activeTab,
      additionalMessage: draft.additionalMessage || undefined,
    };
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
