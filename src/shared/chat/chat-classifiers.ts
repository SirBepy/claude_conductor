// Classification and detection helpers for chat messages. No DOM or HTML
// concerns — pure data transforms over ContentBlock[] and strings.
// Rendering functions live in chat-transforms.ts.

import type { ContentBlock } from "../../types/ipc.generated";
import { blocksToText } from "./content-blocks";

// Turn-status marker injected via `--append-system-prompt` (see
// daemon/lifecycle.rs). Claude ends each reply with `<cc-status:done>`,
// `<cc-status:question>`, `<cc-status:waiting>` (parked on an external
// process it will resume on), or `<cc-status:working>` (own background
// subagents/tasks still running). The app reads it for the sidebar state and
// must never display it. STATUS_TOKEN_RE matches a complete marker anywhere;
// STATUS_TAIL_RE matches an incomplete trailing fragment (a streamed prefix of
// the marker) so the token never flashes mid-stream. The tail pattern is the
// literal "<cc-status:done|question|waiting|working>" with every position
// optional, anchored to end-of-text, with a mandatory leading "<c" to avoid
// eating a lone trailing "<". "waiting" and "working" share the "w" prefix,
// hence the nested alternation under "w".
const STATUS_TOKEN_RE = /<cc-status:(?:done|question|waiting|working)>/gi;
const STATUS_TAIL_RE = /<c(?:c(?:-(?:s(?:t(?:a(?:t(?:u(?:s(?::(?:d(?:o(?:n(?:e)?)?)?|q(?:u(?:e(?:s(?:t(?:i(?:o(?:n)?)?)?)?)?)?)?|w(?:a(?:i(?:t(?:i(?:n(?:g)?)?)?)?)?|o(?:r(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?>?\s*$/i;
// Some model invocations emit XML-style `<cc-status>done</cc-status>` instead
// of the colon form; handle both so neither variant leaks into rendered text.
const STATUS_XML_TOKEN_RE = /<cc-status>(?:done|question|waiting|working)<\/cc-status>/gi;
const STATUS_XML_TAIL_RE = /<cc-status>[\s\S]*$/i;

// Malformed hybrid: colon-opened but XML-closed, e.g. <cc-status:question</cc-status>.
// Observed in the wild from some model invocations. Standalone tail pattern
// (not an extension of STATUS_TAIL_RE) since the existing nested-optional
// chain can't absorb a literal embedded "<" partway through.
const STATUS_HYBRID_TOKEN_RE = /<cc-status:(?:done|question|waiting|working)<\/cc-status>/gi;
const STATUS_HYBRID_TAIL_RE = /<cc-status:(?:done|question|waiting|working)?<(?:\/(?:c(?:c(?:-(?:s(?:t(?:a(?:t(?:u(?:s)?)?)?)?)?)?)?)?)?)?\s*$/i;

// Autopilot marker emitted by the /autopilot skill to signal on/off state.
// The app reads it to toggle the sidebar badge; it must never display in chat.
const AUTOPILOT_TOKEN_RE = /<cc-autopilot:(?:on|off)>/gi;
// Matches an incomplete trailing <cc-autopilot:... fragment so it never flashes.
const AUTOPILOT_TAIL_RE = /<cc-autopilot(?::[^>]*)?\s*$/i;

// Title marker injected alongside the status marker (see daemon/lifecycle.rs).
// Claude emits `<cc-title:Some Title>` each turn; the title is read off the
// transcript for the sidebar and must never display. TITLE_TOKEN_RE matches a
// complete marker; TITLE_TAIL_RE matches an incomplete trailing fragment (the
// literal "<cc-title:" with every position optional, plus any partial title
// text after the colon) so it never flashes mid-stream.
// Some model versions emit XML-style `<cc-title>Text</cc-title>` instead of
// the colon form; TITLE_XML_TOKEN_RE and TITLE_XML_TAIL_RE handle that variant.
const TITLE_TOKEN_RE = /<cc-title:[^>]*>/gi;
const TITLE_TAIL_RE = /<c(?:c(?:-(?:t(?:i(?:t(?:l(?:e(?::[^>]*)?)?)?)?)?)?)?)?\s*$/i;
const TITLE_XML_TOKEN_RE = /<cc-title>[\s\S]*?<\/cc-title>/gi;
const TITLE_XML_TAIL_RE = /<cc-title>[\s\S]*$/i;

// Turn-progress marker. Claude emits `<cc-progress:N/M>` in its text during
// multi-step tasks so the app can show a progress bar. Never displayed.
const PROGRESS_TOKEN_RE = /<cc-progress:\d+\/\d+>/gi;
const PROGRESS_TAIL_RE = /<c(?:c(?:-(?:p(?:r(?:o(?:g(?:r(?:e(?:s(?:s(?::(?:\d+(?:\/\d*)?)?)?)?)?)?)?)?)?)?)?)?)\s*$/i;

// PR preview markers emitted by the /create-pr skill before asking for
// confirmation. The app strips them from chat display and renders a PR card
// instead. <cc-pr-title:> carries the plain-text title; <cc-pr-body:> and
// <cc-pr-commits:> carry base64-encoded markdown body and commits JSON.
const PR_TITLE_TOKEN_RE = /<cc-pr-title:[^>]*>/gi;
const PR_TITLE_TAIL_RE = /<cc-pr-title(?::[^>]*)?\s*$/i;
const PR_BODY_TOKEN_RE = /<cc-pr-body:[A-Za-z0-9+/=\n]*>/gi;
const PR_BODY_TAIL_RE = /<cc-pr-body(?::[A-Za-z0-9+/=]*)?\s*$/i;
const PR_COMMITS_TOKEN_RE = /<cc-pr-commits:[A-Za-z0-9+/=\n]*>/gi;
const PR_COMMITS_TAIL_RE = /<cc-pr-commits(?::[A-Za-z0-9+/=]*)?\s*$/i;

/** Returns the PR preview data if all three markers are present, or null. */
export function detectPrPreviewToken(text: string): { title: string; bodyB64: string; commitsB64: string } | null {
  const titleMatch = /<cc-pr-title:([^>]*)>/i.exec(text);
  const bodyMatch = /<cc-pr-body:([A-Za-z0-9+/=\n]*)>/i.exec(text);
  const commitsMatch = /<cc-pr-commits:([A-Za-z0-9+/=\n]*)>/i.exec(text);
  if (!titleMatch || !bodyMatch || !commitsMatch) return null;
  return {
    title: titleMatch[1] ?? "",
    bodyB64: (bodyMatch[1] ?? "").replace(/\s/g, ""),
    commitsB64: (commitsMatch[1] ?? "").replace(/\s/g, ""),
  };
}

/** Strips the status, title, autopilot, progress, and PR preview markers
 * (complete or partial) plus trailing whitespace, so none ever reaches the
 * rendered body. */
export function stripStatusToken(text: string): string {
  return text
    .replace(STATUS_TOKEN_RE, "")
    .replace(STATUS_XML_TOKEN_RE, "")
    .replace(STATUS_HYBRID_TOKEN_RE, "")
    .replace(TITLE_TOKEN_RE, "")
    .replace(TITLE_XML_TOKEN_RE, "")
    .replace(AUTOPILOT_TOKEN_RE, "")
    .replace(PROGRESS_TOKEN_RE, "")
    .replace(PR_TITLE_TOKEN_RE, "")
    .replace(PR_BODY_TOKEN_RE, "")
    .replace(PR_COMMITS_TOKEN_RE, "")
    .replace(STATUS_TAIL_RE, "")
    .replace(STATUS_XML_TAIL_RE, "")
    .replace(STATUS_HYBRID_TAIL_RE, "")
    .replace(TITLE_TAIL_RE, "")
    .replace(TITLE_XML_TAIL_RE, "")
    .replace(AUTOPILOT_TAIL_RE, "")
    .replace(PROGRESS_TAIL_RE, "")
    .replace(PR_TITLE_TAIL_RE, "")
    .replace(PR_BODY_TAIL_RE, "")
    .replace(PR_COMMITS_TAIL_RE, "")
    .replace(/\s+$/, "");
}

/** Last status marker in `text`, or null if none. Handles both colon form
 *  (`<cc-status:done>`) and XML form (`<cc-status>done</cc-status>`). */
export function detectStatusToken(text: string): "done" | "question" | "waiting" | "working" | null {
  const colon = [...text.matchAll(/<cc-status:(done|question|waiting|working)>/gi)];
  const xml = [...text.matchAll(/<cc-status>(done|question|waiting|working)<\/cc-status>/gi)];
  // Group index [1] is shared across colon/xml/hybrid by construction (each
  // pattern has exactly one capture group at position 1, the status word).
  // A future 4th variant must preserve this or the merge below breaks silently.
  const hybrid = [...text.matchAll(/<cc-status:(done|question|waiting|working)<\/cc-status>/gi)];
  const all = [...colon, ...xml, ...hybrid].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (all.length === 0) return null;
  return all[all.length - 1]![1]!.toLowerCase() as "done" | "question" | "waiting" | "working";
}

/** Last progress marker in `text`, or null if none. Returns { n, m } where n
 * is the current step (1-based) and m is the total step count. */
export function detectProgressToken(text: string): { n: number; m: number } | null {
  const matches = [...text.matchAll(/<cc-progress:(\d+)\/(\d+)>/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const n = parseInt(last[1]!, 10);
  const m = parseInt(last[2]!, 10);
  if (m <= 0 || n < 0 || n > m) return null;
  return { n, m };
}

export interface RenderedMessage {
  kind: "system" | "user" | "assistant" | "tool_use" | "tool_result" | "notification" | "question" | "message" | "preview";
  content?: ContentBlock[];
  text?: string;
  tool?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  output?: ContentBlock;
  is_error?: boolean;
  streaming?: boolean;
  ts: number;
  /** Set on tool_use events that are child calls dispatched by a subagent.
   *  Equals the tool_use id of the parent Agent/Task dispatch. Null for
   *  main-agent tool calls. */
  parentToolUseId?: string | null;
  /** True for system messages that originated from noiseAssistantLabel (e.g.
   *  "Request interrupted by user"). Used to position the chips footer BEFORE
   *  these labels rather than after them. */
  noiseLabel?: boolean;
  /** Explicit turn-boundary signal `isBoundaryMessage` checks - never
   *  derived from the presentational `compactionN` (ai_todo 742). */
  isCompaction?: boolean;
  /** Presentational-only ordinal, derived via `compactionOrdinal` - never
   *  used to decide turn structure; see `isCompaction`. */
  compactionN?: number;
  /** Set on an `is_meta` "Auto-continued" system note once 2+ consecutive
   *  silent turns merged into it (see turnProducedVisibleContent in
   *  turn-visible-content.ts). Renders as a trailing "×N" instead of a
   *  separate note per retry. */
  streakCount?: number;
  /** Source of an `is_meta` note (classifyMetaTurn); renders as a chip. */
  metaKind?: MetaTurnKind;
  metaDetail?: string;
  /** Retracted via `update_message`; `text` keeps the original for the tooltip. */
  retracted?: boolean;
  /** Set when a failed send_message's tool_result was is_error:true - stays
   *  visible as a "failed to send" ghost instead of being deleted. */
  failed?: boolean;
  /** From a turn the user interrupted. Cleared by revising or retracting. */
  dimmed?: boolean;
  /** Live per-question answered state for a still-pending `kind:"question"`
   *  card, mirrored from the floating prompt card's draft as the user answers
   *  it (ChatRenderer.updateQuestionProgress). Index-aligned with the parsed
   *  questions in `input`. Never set once `text` is populated (resolved). */
  liveAnswered?: boolean[];
  /** The user's free-form note typed into the card's own review step (never
   *  the composer/held-queue), folded in via the <auq-extra/> sentinel once it
   *  arrives - see chat-question-card.ts's resolvePendingQuestionExtra. Renders
   *  inside the SAME card (tool-views.ts), never as a separate bubble. */
  extraText?: string;
  /** Set on tool_result events whose `output` was shortened to a preview by
   *  `read_page` (see types/chat.rs). The row renders a "Load full output"
   *  affordance instead of the preview text; clicking it fetches the real
   *  content via `load_event_detail`, keyed on `fullSeq` + `tool_use_id`. */
  outputTruncated?: boolean;
  fullSeq?: number;
  /** Session id of the AI that sent this on Joe's behalf (a Jarvis relay,
   *  todo 682) - set only on kind:"user" rows, null/undefined when Joe typed
   *  it himself. Drives the character+project icon-pair tag. */
  authorSessionId?: string | null;
  /** `kind:"preview"` only. The pushed document and its identity, read off the
   *  show_preview tool_use input - the daemon's snapshot store is the rail's
   *  source, not this row's, so a card renders even when the push never
   *  reached the store. */
  previewHtml?: string;
  previewSlug?: string;
}

/**
 * A turn boundary row: a real user message or a compaction marker. These open
 * a turn, so the tool/assistant rows that follow belong to it. Single source
 * of truth for "what starts a turn", shared by the renderer (folding the
 * window's leading partial turn at initial load) and the paginator (folding
 * prepended ranges). Mirrors the user_message gate in ChatRenderer.handleEvent:
 * a tool-result-only user line renders to empty content and is dropped (never
 * becomes a kind:"user" row), so checking kind here is sufficient.
 */
export function isBoundaryMessage(m: RenderedMessage): boolean {
  return m.kind === "user" || (m.kind === "system" && m.isCompaction === true);
}

/** 1-based ordinal of `messages[index]` among compaction rows - pure
 *  function of the list, not a mutable counter (ai_todo 742). */
export function compactionOrdinal(messages: RenderedMessage[], index: number): number {
  let n = 0;
  for (let i = 0; i <= index; i++) {
    if (messages[i]?.isCompaction) n++;
  }
  return n;
}

// Claude Code wraps slash-command prompts with internal tags like
// `<command-name>`, `<command-message>`, `<command-args>`, and shells out
// stdout via `<local-command-stdout>`. These are session bookkeeping, not
// content the user wants to see in the chat.
//
// command-message/local-command-stdout: strip the ENTIRE block including
// content (the menu label "commit" / stdout output should not appear in the
// bubble). command-args: strip only the tags, keep content (it's the user's
// typed text). command-name: its content already carries the leading slash
// (e.g. "/commit"), captured separately below and reattached to the front
// of the args, instead of being deleted, so the normalized text reconstructs
// the same "/name args" string the composer's optimistic echo carries. The
// two must match byte-for-byte: this normalized form also feeds the live
// dedup signature (sigOf in event-store.ts) that reconciles the runner
// stream's synthetic echo against the file watcher's JSONL-sourced copy of
// the same turn. Deleting the name (the old behavior) made the two sigs
// differ, "/commit pushnbump" vs "pushnbump", so the watcher's delivery
// was never recognized as a duplicate and rendered as a second, chip-less
// bubble underneath the real one.
const COMMAND_NAME_RE = /<command-name(?:\s[^>]*)?>([\s\S]*?)<\/command-name>/i;
const COMMAND_BLOCK_RE = /<(?:command-name|command-message|local-command-stdout)(?:\s[^>]*)?>[\s\S]*?<\/(?:command-name|command-message|local-command-stdout)>/gi;
const COMMAND_ARGS_TAG_RE = /<\/?command-args(?:\s[^>]*)?>/gi;

// When /compact runs, Claude Code injects the generated summary back into the
// conversation as a user message with this wrapper. The summary can be thousands
// of characters; rendering it as a normal user bubble is confusing and noisy.
// Detect the wrapper and replace with a compact system notice instead.
const COMPACT_COMMAND_RE = /<command-name>compact<\/command-name>/i;

// Background-task completion events the harness injects as synthetic
// user-role messages when `run_in_background: true` finishes. Multi-line
// XML-ish block; strip the whole thing including contents.
const TASK_NOTIFICATION_RE = /<task-notification[\s\S]*?<\/task-notification>/gi;

// When the user invokes a skill, Claude Code appends the entire SKILL.md
// body to the same user message AFTER `</command-args>`, followed by an
// `ARGUMENTS: ...` line repeating what the user typed. Strip from the
// `Base directory for this skill:` marker through end-of-text so the chat
// shows just the user's input (which is already preserved inside the
// command-args block).
const SKILL_BODY_RE = /^Base directory for this skill:[\s\S]*$/m;

// Normalize raw user-message text for display and cross-source dedup: removes
// the command scaffolding Claude Code adds when expanding slash commands, leaving
// only the user's typed text (the command-name's "/word" reattached to the
// front of the command-args content — see COMMAND_NAME_RE above for why).
export function normalizeUserMessageText(text: string): string {
  const nameMatch = COMMAND_NAME_RE.exec(text);
  const body = text
    .replace(COMMAND_BLOCK_RE, "")
    .replace(COMMAND_ARGS_TAG_RE, "")
    .replace(SKILL_BODY_RE, "")
    .replace(TASK_NOTIFICATION_RE, "")
    .trim();
  const name = nameMatch?.[1]?.trim();
  if (!name) return body;
  return body ? `${name} ${body}` : name;
}

export function isCompactUserMessage(blocks: ContentBlock[]): boolean {
  return blocks.some(b => b.type === "text" && COMPACT_COMMAND_RE.test(b.text));
}

export function cleanUserBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      let stripped = normalizeUserMessageText(b.text);
      stripped = stripped.trim();
      if (stripped.length === 0) continue;
      out.push({ type: "text", text: stripped });
    } else {
      out.push(b);
    }
  }
  return out;
}

// Single-word "continue" messages sent by the rate-limit auto-continue system.
// These are internal plumbing and should not render as user bubbles.
export function isSilentSystemUserMessage(cleaned: ContentBlock[]): boolean {
  const first = cleaned[0];
  if (cleaned.length !== 1 || !first || first.type !== "text") return false;
  return (first as { type: "text"; text: string }).text.trim().toLowerCase() === "continue";
}

// The resume system injects "Continue from where you left off." as a user turn
// when a chat is continued (e.g. after a restart). The user never typed it, so
// it must not render as a user bubble - drop it entirely; the assistant's
// "Continuing chat" notice is the visible resume marker.
// Also drops "[Request interrupted by user]" which the CLI emits as a synthetic
// user turn in the context after a cancel - it arrives out of order (after the
// user's next message) and the assistant-side noiseLabel already handles it.
export function isResumeContinuationUserMessage(cleaned: ContentBlock[]): boolean {
  const first = cleaned[0];
  if (cleaned.length !== 1 || !first || first.type !== "text") return false;
  const t = (first as { type: "text"; text: string }).text.trim();
  return /^continue from where you left off\.?$/i.test(t)
    || /^\[request interrupted( by user)?\]$/i.test(t);
}

export type MetaTurnKind = "peer" | "fleet" | "retry" | "hygiene" | "wake";

const META_KIND_LABELS: Record<MetaTurnKind, string> = {
  peer: "Peer message",
  fleet: "Fleet update",
  retry: "Retrying",
  hygiene: "Hygiene pass",
  wake: "Scheduled wake",
};

/** Icon per meta-turn kind - single source shared by the (hidden) centered
 *  marker's HTML and the inline turn-strip chip, so both stay in sync. */
export const META_KIND_ICONS: Record<MetaTurnKind, string> = {
  peer: "ph-users-three",
  fleet: "ph-broadcast",
  retry: "ph-arrow-clockwise",
  hygiene: "ph-broom",
  wake: "ph-alarm",
};

// The CLI's own no-visible-output retry nudge, not a real wake. Substring
// match tolerates the raw text's wrapping brackets.
const RETRY_NUDGE_TEXT = "Your previous response had no visible output. Please continue and produce a user-visible response.";

/** `[repo-channel]`/`[fleet]`/`[hygiene]`/`[schedule]` are daemon-tagged and
 *  win over RETRY_NUDGE_TEXT (the CLI's own nudge), which a tagged prompt's
 *  body could otherwise quote; anything else untagged is a bare
 *  ScheduleWakeup/cron tick. */
export function classifyMetaTurn(cleaned: ContentBlock[]): { kind: MetaTurnKind; label: string; detail: string } {
  const text = blocksToText(cleaned).trim();
  const kind: MetaTurnKind = text.startsWith("[repo-channel]") ? "peer"
    : text.startsWith("[fleet]") ? "fleet"
    : text.startsWith("[hygiene]") ? "hygiene"
    : text.startsWith("[schedule]") ? "wake"
    : text.includes(RETRY_NUDGE_TEXT) ? "retry"
    : "wake";
  return { kind, label: META_KIND_LABELS[kind], detail: text };
}

// Assistant messages that are internal CLI noise. Returns a display label for
// the system notice, or null if the text is real assistant content.
const NOISE_PATTERNS: [RegExp, string][] = [
  // Emitted when a session is resumed with nothing new to do (e.g. continuing a
  // chat after a restart). Shown as "Continuing chat" rather than the raw
  // "No response requested." so it reads as the resume marker, not an error.
  [/^no response requested\.?$/i, "Continuing chat"],
  [/^\[request interrupted( by user)?\]$/i, "Request interrupted by user"],
];
export function noiseAssistantLabel(text: string): string | null {
  const t = text.trim();
  for (const [re, label] of NOISE_PATTERNS) {
    if (re.test(t)) return label;
  }
  return null;
}
export function isNoiseAssistantText(text: string): boolean {
  return noiseAssistantLabel(text) !== null;
}
