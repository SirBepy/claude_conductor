import type { ContentBlock, ChatEvent } from "../../types/ipc.generated";
import {
  type RenderedMessage,
  isCompactUserMessage,
  cleanUserBlocks,
  isResumeContinuationUserMessage,
  isSilentSystemUserMessage,
  classifyMetaTurn,
  noiseAssistantLabel,
} from "./chat-classifiers";
import { isAskQuestionTool } from "./tool-meta";
export type { RenderedMessage } from "./chat-classifiers";

// Matches <file:PATH> or <file:PATH::DISPLAYNAME> tokens in user message text.
// Group 1 = path, group 2 = display name (optional).
const FILE_TOKEN_RE = /<file:(.+?)(?:::(.+?))?>/g;

// Sentinel prefixing a message that is the user's answer to a fire-and-forget
// AskUserQuestion card (see permission-modal/index.ts). Content-free like the
// voice tag: the model still reads the framed "User answered…" body inline.
// chat-event-handler folds it back into the question card it answers (so the
// card shows the real answers instead of "awaiting answer") rather than
// rendering a separate bubble; the "answer" chip below is only the fallback
// for the rare case where no matching pending card is found (e.g. it queued
// alongside other held messages in the same send).
export const AUQ_ANSWER_SENTINEL = "<auq-answer/>";
const AUQ_ANSWER_RE = /<auq-answer\s*\/>/g;

// Sentinel prefixing the card's own "additional message" note - distinct
// from AUQ_ANSWER_SENTINEL so a queued composer draft never collides with it.
export const AUQ_EXTRA_SENTINEL = "<auq-extra/>";
const AUQ_EXTRA_RE = /<auq-extra\s*\/>/g;

/** Carries the "dismissed" substring tool-views.ts's resolution detection already
 *  matches on. Live-only: set from a `question_skipped` notification, never
 *  replayed from history (todo 661). */
export const AUQ_SKIPPED_TEXT = "User dismissed the question(s).";

/** Every `<file:PATH...>` path the user attached in a message's text blocks,
 *  normalized (lowercased, backslashes to slashes) so Read tool_use inputs
 *  can be matched against it despite slash/case differences. Used to keep
 *  Claude's own Read of a just-sent attachment from resurfacing as a
 *  duplicate "screenshot" (see turn-collapse.ts's collectScreenshotShots). */
export function extractAttachedFilePaths(blocks: ContentBlock[]): Set<string> {
  const paths = new Set<string>();
  for (const b of blocks) {
    if (b.type !== "text") continue;
    FILE_TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FILE_TOKEN_RE.exec(b.text)) !== null) {
      const path = match[1];
      if (path) paths.add(path.toLowerCase().replace(/\\/g, "/"));
    }
    FILE_TOKEN_RE.lastIndex = 0;
  }
  return paths;
}

/** The raw "User answered…" framing text of a `<auq-answer/>`-tagged user
 *  message (sentinel stripped), or null if no block qualifies. A qualifying
 *  block is a text block whose content STARTS with the sentinel - held
 *  prose bundled alongside it (see held-messages.ts's bundleHeld) rides in
 *  its own separate block(s) and is ignored here, not scanned into the
 *  fold. */
export function extractAuqAnswerText(blocks: ContentBlock[]): string | null {
  const b = blocks.find((x) => x && x.type === "text" && x.text.startsWith(AUQ_ANSWER_SENTINEL));
  if (!b || b.type !== "text") return null;
  AUQ_ANSWER_RE.lastIndex = 0;
  return b.text.replace(AUQ_ANSWER_RE, "").trim();
}

/** `blocks` with its AUQ-answer sentinel block (if any) removed - the
 *  remaining held/typed prose that rode along in the same bundleHeld send,
 *  which still needs to render/transform as an ordinary user message once
 *  the sentinel block has been folded into the question card. */
export function stripAuqAnswerBlock(blocks: ContentBlock[]): ContentBlock[] {
  const idx = blocks.findIndex((b) => b && b.type === "text" && b.text.startsWith(AUQ_ANSWER_SENTINEL));
  if (idx === -1) return blocks;
  return blocks.filter((_, i) => i !== idx);
}

/** The card's own free-form note (sentinel stripped), or null if none.
 *  Mirrors extractAuqAnswerText but for the review step's own sentinel. */
export function extractAuqExtraText(blocks: ContentBlock[]): string | null {
  const b = blocks.find((x) => x && x.type === "text" && x.text.startsWith(AUQ_EXTRA_SENTINEL));
  if (!b || b.type !== "text") return null;
  AUQ_EXTRA_RE.lastIndex = 0;
  return b.text.replace(AUQ_EXTRA_RE, "").trim();
}

/** Mirrors stripAuqAnswerBlock for the card-note sentinel. */
export function stripAuqExtraBlock(blocks: ContentBlock[]): ContentBlock[] {
  const idx = blocks.findIndex((b) => b && b.type === "text" && b.text.startsWith(AUQ_EXTRA_SENTINEL));
  if (idx === -1) return blocks;
  return blocks.filter((_, i) => i !== idx);
}

export function eventToRenderedMessage(ev: ChatEvent): RenderedMessage | null {
  const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
  switch (ev.type) {
    case "session_started":
      return { kind: "system", text: `Session started${ev.model ? ` (${ev.model})` : ""}`, ts };
    case "user_message": {
      if (isCompactUserMessage(ev.content)) {
        // No compactionN: this converter is stateless (single event in, no
        // list) - the paginated caller has no full message list to derive
        // an ordinal from. isCompaction alone is enough for isBoundaryMessage.
        return { kind: "system", text: "Conversation compacted", ts, isCompaction: true };
      }
      const cleaned = cleanUserBlocks(ev.content);
      if (cleaned.length === 0) return null;
      if (isResumeContinuationUserMessage(cleaned)) return null;
      if (isSilentSystemUserMessage(cleaned)) return { kind: "system", text: "Continuing session…", ts };
      // A peer channel wake (todo 743) is also is_meta but carries a known
      // sender - render as an authored bubble, not a generic meta chip.
      if (ev.is_meta && !ev.author_session_id) {
        const meta = classifyMetaTurn(cleaned);
        return { kind: "system", text: meta.label, metaKind: meta.kind, metaDetail: meta.detail, ts };
      }
      return { kind: "user", content: cleaned, ts, authorSessionId: ev.author_session_id ?? null };
    }
    case "assistant_message": {
      if (!ev.streaming) {
        const t = (ev.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("").trim();
        const label = noiseAssistantLabel(t);
        if (label !== null) return { kind: "system", text: label, ts, noiseLabel: true };
      }
      return { kind: "assistant", content: ev.content, streaming: ev.streaming, ts };
    }
    case "tool_use":
      // Mirrors chat-event-handler.ts's live-path special-case so a send_message
      // call renders as a bubble on the older-page (scrollback) path too,
      // instead of hidden narration (see project_quiet_mode_chat_architecture).
      if (ev.tool_name === "mcp__cc_conductor__send_message" && !ev.parent_tool_use_id) {
        const text = typeof (ev.input as { text?: unknown })?.text === "string"
          ? (ev.input as { text: string }).text : "";
        return { kind: "message", text, id: ev.id, ts, parentToolUseId: null };
      }
      // Mirrors chat-event-handler.ts's AUQ special-case (builtin or MCP ask
      // channel, see isAskQuestionTool) so a question renders the same card on
      // the older-page (scrollback) path - its answer, if any, is folded in by
      // chat-pagination.ts's prependEvents (mirrors the tool_result absorb).
      if (isAskQuestionTool(ev.tool_name) && !ev.parent_tool_use_id) {
        return { kind: "question", tool: ev.tool_name, input: ev.input, id: ev.id, ts, parentToolUseId: null };
      }
      return { kind: "tool_use", tool: ev.tool_name, input: ev.input, id: ev.id, ts, parentToolUseId: ev.parent_tool_use_id ?? null };
    case "tool_result":
      return {
        kind: "tool_result",
        tool_use_id: ev.tool_use_id,
        output: ev.output,
        is_error: ev.is_error,
        ts,
        outputTruncated: ev.output_truncated,
        fullSeq: ev.full_seq !== null ? Number(ev.full_seq) : undefined,
      };
    case "notification":
      return { kind: "notification", text: ev.body, ts: Date.now() };
    case "session_ended":
      return { kind: "system", text: `Session ended${ev.exit_code !== null ? ` (exit ${ev.exit_code})` : ""}`, ts };
    default:
      return null;
  }
}
