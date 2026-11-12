import type { SubFacts } from "../../../shared/chat/subchat-cards";
/** Where a prompt's card shows, stamped by the daemon (subchats/routing.rs).
 *  `session_id` is always the asker and the answer target. For a hidden sub,
 *  `display_session_id` is its main chat, whose window shows the card. Absent
 *  (older daemon, peer machine) or equal to `session_id` for every other chat,
 *  Jarvis workers included, which then behave as they always did. */
export interface PromptRouting {
  session_id?: string;
  display_session_id?: string;
  /** A sub's row name, for the card's "from" line. Only present for a sub. */
  sub_name?: string;
  /** The one-line job a sub was given. Absent until the spawn path stores it. */
  sub_task?: string;
}

export interface PermissionRequestedPayload extends PromptRouting {
  id: string;
  tool_name: string;
  input: unknown;
}

/** The `request_secret` MCP tool's blocking prompt: asks Joe to
 *  paste a value that gets written straight to a key=value file, never
 *  surfaced to the model. `file` is the daemon-resolved absolute path;
 *  `key` is the line within it the value gets saved under. */
export interface SecretRequestedPayload extends PromptRouting {
  id: string;
  label: string;
  file: string;
  key: string;
  /** Deleted by the daemon when the asking chat closes. */
  temporary?: boolean;
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
  /** HTML fragment showing what this option looks like, rendered in a
   *  sandboxed frame with the app's stylesheets (option-preview-doc.ts).
   *  The MCP tool requires one on every option of a `ux` question. */
  preview?: string;
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
  /** One picture of what the question is about, shown above its text. Same
   *  sandboxed-frame HTML as an option's `preview`, but it belongs to the
   *  question, so it fits a question whose options all look alike ("is this
   *  good, or do you want to change something?"). Never required. */
  preview?: string;
}

export interface QuestionRequestedPayload extends PromptRouting {
  id: string;
  questions: Question | Question[];
  /** Raised by the daemon for its own code (a stalled sub, a close approval),
   *  not asked by a model: its answer goes to daemon code alone, so the card has
   *  no free-text box and no answer path posts a message to the chat it shows in. */
  daemon_card?: boolean;
  /** A daemon card that asks for no attention (a decisions checkup): it is shown
   *  when Joe opens the chat, behind every other card there, and gets no red dot,
   *  ring or "input needed" state. */
  quiet?: boolean;
  /** Set by the daemon on a sub's final-stamp question: the facts it read from
   *  git and the sub's transcript, shown as chips under the picture. */
  final_stamp?: { sub_id?: string; facts: SubFacts };
  /** The sub a daemon card is about (`cards::raise_card`), named in `sub_name`. */
  sub_id?: string;
  /** Set by the daemon's builtin-AskUserQuestion hard-block fallback
   *  (hooks_server/question.rs) when the model ignored the redirect to the
   *  MCP tool - never present on the normal path. */
  degraded_builtin?: boolean;
  /** Set by `post_fire_and_forget_question` (hooks_server/question.rs) when
   *  this session already had ANOTHER open, unanswered question at the
   *  moment this one was asked. Without it, an old unanswered question that
   *  the model circles back to later resurfaces with no hint that it isn't
   *  new, and reads as a duplicate of whatever was just answered. */
  has_older_pending?: boolean;
  /** Daemon-assigned monotonic order (`DaemonState::next_prompt_seq`) - lets
   *  `markLatestQuestion` tell a genuinely newer question apart from a stale
   *  one surfaced out of order (the prompt store's snapshot order is not
   *  reliably chronological). Absent on prompts from an older daemon build. */
  seq?: number;
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
  /** Panel index this was attached from (a question index, or questions.length
   *  for the review step). The strip only renders on its own panel; a legacy
   *  draft with no stamp falls back to 0. */
  panel?: number;
  /** Shown on the card but not yet on the daemon; never persisted (no path). */
  uploading?: boolean;
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
  /** Per-option notes, question index -> option label -> text. A note only
   *  ships while its option is ticked, but is kept across an untick so a
   *  re-tick brings it back. Optional: older drafts and external callers have
   *  none. */
  notes?: OptionNotes;
}

export type OptionNotes = Map<number, Map<string, string>>;

/** One chip of the picker on a card: a chat (a sub, or the main chat itself)
 *  with a question open in the same window, and how many questions it has. */
export interface AskerChip {
  /** The asking session, which is also the answer target. */
  askerId: string;
  label: string;
  count: number;
  /** True for the main chat's own question, shown with a chat icon. */
  isMain: boolean;
  active: boolean;
  /** A permission prompt held behind the card now up, not a question. */
  blocking?: boolean;
}

/** The chat a card says it comes from. A sub is drawn as its avatar (initials, ring,
 *  model battery) beside its name; the main chat as a plain "Main chat" chip. */
export interface AskerFace {
  name?: string;
  /** The sub's one-line job. Omitted while the daemon has none. */
  task?: string;
  /** The sub's model and effort, for the battery on its avatar. */
  model?: string;
  effort?: string;
  /** The main chat's own card: no avatar, the chip just reads "Main chat". */
  main?: boolean;
}

export interface QuestionUIOpts {
  /** Prompt id, so the card can be torn down externally (expiry / resolved elsewhere). */
  id?: string;
  /** Session the prompt belongs to - used to scope draft snapshots. */
  sessionId?: string;
  /** The chat whose window shows this card, when it is not `sessionId`: a hidden
   *  sub's card shows in its main chat. */
  displayId?: string;
  questions: Question[];
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
  /** Mirrors QuestionRequestedPayload.has_older_pending - badges this card so
   *  it's clear it isn't a duplicate of one just answered, it's a different
   *  question that was left open while something else was going on. */
  hasOlderPending?: boolean;
  /** The picker between chats with a question open in this window. Read on every
   *  render, so it follows arrivals and answers. `null` or fewer than two chips
   *  draws no strip. */
  askers?: () => AskerChip[] | null;
  onPickAsker?: (askerId: string) => void;
  /** A card the daemon raised for its own code. Draws no free-text box: there is
   *  no model to read one, and the answer is one of the card's options. */
  daemonCard?: boolean;
  /** A sub's final stamp: the fact chips drawn under the question's picture. */
  finalStamp?: { facts: SubFacts };
  /** Who asks, drawn as the header chip: a hidden sub (its avatar and name, with
   *  its one-line job under the header), or the main chat. Unset for a plain chat. */
  from?: AskerFace;
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
