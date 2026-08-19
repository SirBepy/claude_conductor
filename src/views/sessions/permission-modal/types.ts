export interface PermissionRequestedPayload {
  id: string;
  tool_name: string;
  input: unknown;
  session_id?: string;
}

// Single source (todo 586): the domain/badge value lists live only here, as
// record keys - the unions, and the runtime whitelists below, both derive
// from these instead of hand-duplicating the same strings.
export const BADGE_META = {
  recommended: { cls: "rec", icon: "ph-fill ph-star", label: "Recommended" },
  long_term: { cls: "long", icon: "ph-fill ph-tree", label: "Long-term best" },
  short_term: { cls: "short", icon: "ph-fill ph-lightning", label: "Short-term best" },
} satisfies Record<string, { cls: string; icon: string; label: string }>;

export type OptionBadge = keyof typeof BADGE_META;

export const BADGES = new Set(Object.keys(BADGE_META));

export interface QuestionOption {
  label: string;
  description?: string;
  /** Zero or more; an option can be both recommended AND long-term best. */
  badges?: OptionBadge[];
}

export const DOMAIN_META = {
  ux: { icon: "ph-fill ph-paint-brush-broad", label: "User experience" },
  arch: { icon: "ph-fill ph-blueprint", label: "Architecture" },
  sec: { icon: "ph-fill ph-shield-check", label: "Security" },
  data: { icon: "ph-fill ph-database", label: "Data" },
  tooling: { icon: "ph-fill ph-wrench", label: "Tooling" },
  infra: { icon: "ph-fill ph-stack", label: "Infrastructure" },
  billing: { icon: "ph-fill ph-currency-circle-dollar", label: "Billing" },
} satisfies Record<string, { icon: string; label: string }>;

export type QuestionDomain = keyof typeof DOMAIN_META;

export const DOMAINS = new Set(Object.keys(DOMAIN_META));

export interface Question {
  question: string;
  header?: string;
  domain?: QuestionDomain;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

export interface QuestionRequestedPayload {
  id: string;
  questions: Question | Question[];
  session_id?: string;
  /** Set by the daemon's builtin-AskUserQuestion hard-block fallback
   *  (hooks_server/question.rs) when the model ignored the redirect to the
   *  MCP tool - never present on the normal path. */
  degraded_builtin?: boolean;
}

export type Answers = Record<string, string | string[]>;

export type Selection = string | Set<string>;

/** A clipboard/file-picker attachment staged on an AUQ card. Same shape as the
 *  composer's own `Attachment` (shared/chat/composer-attachments.ts) - kept
 *  separate since reusing that class's localStorage persistence (keyed by
 *  session id) would collide with the main composer's own draft. */
export interface AuqAttachment {
  mime: string;
  /** base64, empty until hydrated (a restored draft only carries path+size -
   *  see draft-persistence.ts and attachments.ts's hydrateMissingData). */
  data: string;
  path: string | null;
  filename: string;
  /** Raw decoded byte size, known at attach time regardless of hydration. */
  size: number;
}

export interface QuestionDraft {
  freeText: Map<number, string>;
  selections: Map<number, Selection>;
  activeTab: number;
  /** Free-form text added on the review step. Only meaningful when the card
   *  was built with `supportsExtras`; empty string otherwise. */
  additionalMessage: string;
  /** Pasted-image attachments. Persisted as path+mime+filename+size only (no
   *  base64) - see draft-persistence.ts's StoredDraft. */
  attachments: AuqAttachment[];
}

export interface QuestionUIOpts {
  /** Prompt id, so the card can be torn down externally (expiry / resolved elsewhere). */
  id?: string;
  /** Session the prompt belongs to - used to scope draft snapshots. */
  sessionId?: string;
  questions: Question[];
  titleIcon: string;
  rightChipHtml?: string;
  submitLabel: string;
  submitIcon: string;
  /** Project directory for scoping the "/" skill/command suggestion popup
   *  (same provider the composer uses) - project-scoped entries need it, but
   *  it's optional: SlashProvider.start(null) still surfaces user/builtin ones. */
  cwd?: string | null;
  /** Enables the review-step "additional message" field + image-paste
   *  attachments. Only index.ts's async MCP flow can deliver these to Claude
   *  (permission-card.ts's built-in-tool flow settles via a plain
   *  deny.message string with no attachment channel, so it leaves this unset). */
  supportsExtras?: boolean;
  /** Mirrors QuestionRequestedPayload.degraded_builtin - shows the same
   *  diagnostic marker on the LIVE card that tool-views.ts shows on the
   *  historical transcript card. */
  degradedBuiltin?: boolean;
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
