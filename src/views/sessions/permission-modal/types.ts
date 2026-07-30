export interface PermissionRequestedPayload {
  id: string;
  tool_name: string;
  input: unknown;
  session_id?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

export interface QuestionRequestedPayload {
  id: string;
  questions: Question | Question[];
  session_id?: string;
}

export type Answers = Record<string, string | string[]>;

export type Selection = string | Set<string>;

/** A clipboard/file-picker attachment staged on an AUQ card. Same shape as the
 *  composer's own `Attachment` (shared/chat/composer-attachments.ts); kept as a
 *  separate type here since the card doesn't reuse that class (its localStorage
 *  persistence is keyed by session id and would collide with the main
 *  composer's own draft for the same session). */
export interface AuqAttachment {
  mime: string;
  data: string; // base64 (no data: prefix)
  path: string | null;
  filename: string;
}

export interface QuestionDraft {
  freeText: Map<number, string>;
  selections: Map<number, Selection>;
  activeTab: number;
  /** Free-form text added on the review step. Only meaningful when the card
   *  was built with `supportsExtras`; empty string otherwise. */
  additionalMessage: string;
  /** Pasted-image attachments, shared across every step of the card. Not
   *  persisted to localStorage (base64 bytes are too heavy for a draft) - only
   *  carried across an in-app switch-away/back via the in-memory snapshot. */
  attachments: AuqAttachment[];
}

export interface QuestionUIOpts {
  /** Prompt id, so the card can be torn down externally (expiry / resolved elsewhere). */
  id?: string;
  /** Session the prompt belongs to - used to scope draft snapshots. */
  sessionId?: string;
  questions: Question[];
  titleIcon: string;
  titleText: string;
  rightChipHtml?: string;
  submitLabel: string;
  submitIcon: string;
  /** Enables the review-step "additional message" field and image-paste
   *  attachments. Only the async MCP question flow (permission-modal/index.ts)
   *  can actually deliver these to Claude as a follow-up message - the
   *  built-in-tool AskUserQuestion flow (permission-card.ts) settles via a
   *  plain deny.message string with no channel for attachments, so it leaves
   *  this unset and gets the plain card unchanged. */
  supportsExtras?: boolean;
  onSubmit: (
    answers: Answers,
    extras: { additionalMessage: string; attachments: AuqAttachment[] },
  ) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  cancelLabel: string;
  /** Partial answers to restore when re-surfacing a parked card. */
  initialDraft?: QuestionDraft;
  /** Fired whenever the draft (selections/free text/active tab) changes, so a
   *  caller can persist it and/or mirror progress into the chat transcript. */
  onDraftChange?: (draft: QuestionDraft) => void;
}
