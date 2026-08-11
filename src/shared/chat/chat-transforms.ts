import MarkdownIt from "markdown-it";
import type { ContentBlock, ChatEvent } from "../../types/ipc.generated";
import { escapeHtml } from "../escape-html";
import { parseFileEdit } from "./file-edits";
import { renderEditWindow } from "./edit-window";
import { basename } from "../path-utils";
import { toolSummary } from "./tool-meta";
import { wrapTables, linkifyInlineCodeUrls, highlightKeywords, highlightSlashMentions } from "./markdown-highlight";
export { highlightSlashMentions, highlightComposerInput } from "./markdown-highlight";
import {
  type RenderedMessage,
  stripStatusToken,
  isCompactUserMessage,
  cleanUserBlocks,
  isResumeContinuationUserMessage,
  isSilentSystemUserMessage,
  classifyMetaTurn,
  noiseAssistantLabel,
  detectPrPreviewToken,
  META_KIND_ICONS,
} from "./chat-classifiers";
export type { RenderedMessage } from "./chat-classifiers";
export { isBoundaryMessage, stripStatusToken, detectStatusToken, detectProgressToken, detectHandoffToken, normalizeUserMessageText, isCompactUserMessage, cleanUserBlocks, isSilentSystemUserMessage, isResumeContinuationUserMessage, classifyMetaTurn, noiseAssistantLabel, isNoiseAssistantText, detectPrPreviewToken } from "./chat-classifiers";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});
// .md is the Moldova ccTLD — linkify-it treats "CLAUDE.md" as a bare URL.
// Disable it so filenames never become links.
md.linkify.tlds("md", false);

// User messages: render single newlines as hard breaks so a multi-line message
// the user typed (Shift+Enter) keeps its line breaks instead of collapsing into
// one paragraph. Assistant/tool output keeps the default `md` (no forced breaks)
// so Claude's own markdown paragraphing renders normally.
const mdBreaks = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: true,
});
mdBreaks.linkify.tlds("md", false);

// PR preview bodies are Claude-authored (git commits / /create-pr output),
// not arbitrary chat/tool content, so raw HTML like GitHub's <details>
// collapsible sections is safe to render here even though the general
// chat renderer above keeps html:false as a blast-radius guard.
const mdHtml = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
});
mdHtml.linkify.tlds("md", false);

// Matches <file:PATH> or <file:PATH::DISPLAYNAME> tokens in user message text.
// Group 1 = path, group 2 = display name (optional).
const FILE_TOKEN_RE = /<file:(.+?)(?:::(.+?))?>/g;

// A large paste held in the composer is sent wrapped in this sentinel (see
// composer.ts). Claude reads the full body inline; the chat collapses the
// wrapper into a clickable chip so the user never sees the wall of text in
// their own message. Group 1 = display name, group 2 = body.
// Matches both nonce format (new) and legacy format (old messages without nonce).
// New:    <pasted-log id="NONCE" name="NAME">BODY</pasted-log:NONCE>
// Legacy: <pasted-log name="NAME">BODY</pasted-log>
// Groups: [1]=nonce, [2]=name (new) | [3]=body (new) | [4]=name (legacy) | [5]=body (legacy)
const PASTED_LOG_RE = /<pasted-log id="([^"]+)" name="([^"]*)">\n?([\s\S]*?)\n?<\/pasted-log:\1>|<pasted-log name="([^"]*)">\n?([\s\S]*?)\n?<\/pasted-log>/g;

// Sentinel the composer appends when a message was dictated by voice. It carries
// no content; the renderer strips it and prepends a small mic chip so the user
// sees "this was voice" without raw markup (the model still receives the tag).
const VOICE_INPUT_RE = /<voice-input\s*\/>/g;

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

function renderTextBlock(rawText: string, breaks = false, fileChips = false): string {
  const stripped = stripStatusToken(rawText);
  // Only user messages legitimately carry the composer's user-only sentinels
  // (<file:>, <pasted-log>, <voice-input>). For every other role (assistant,
  // tool_result, system) any such token is example/code text the model wrote,
  // so render straight markdown and never chip-convert it.
  if (!fileChips) {
    return `<div class="block text">${renderMarkdown(stripped, breaks)}</div>`;
  }
  // Peel off content-free user sentinels (voice dictation, AUQ answer) into
  // leading chips. The model still receives the raw tags; the user just sees a
  // small chip instead of markup.
  VOICE_INPUT_RE.lastIndex = 0;
  const hasVoice = VOICE_INPUT_RE.test(stripped);
  VOICE_INPUT_RE.lastIndex = 0;
  AUQ_ANSWER_RE.lastIndex = 0;
  const hasAuqAnswer = AUQ_ANSWER_RE.test(stripped);
  AUQ_ANSWER_RE.lastIndex = 0;
  let text = stripped;
  if (hasVoice) text = text.replace(VOICE_INPUT_RE, "");
  if (hasAuqAnswer) text = text.replace(AUQ_ANSWER_RE, "");
  if (hasVoice || hasAuqAnswer) text = text.trim();
  // The AUQ-answer block is always exactly the sentinel + the machine-formatted
  // "User answered…" framing (see permission-modal/index.ts onSubmit) - never
  // mixed with free-typed user text in the same content block. The resolved
  // question card rendered just above already shows the same Q/A nicely, so
  // fold the raw framing text entirely into the chip (click to reveal) instead
  // of dumping a second, unstyled copy underneath it.
  if (hasAuqAnswer) return auqAnswerChipHtml(text) + (hasVoice ? voiceInputChipHtml() : "");
  const prefix = hasVoice ? voiceInputChipHtml() : "";
  // First peel off any <pasted-log> blocks into chips; render the surrounding
  // text (which may still carry <file:> tokens) through the file-token path.
  PASTED_LOG_RE.lastIndex = 0;
  if (!PASTED_LOG_RE.test(text)) {
    PASTED_LOG_RE.lastIndex = 0;
    return prefix + renderFileSegments(text, breaks);
  }
  PASTED_LOG_RE.lastIndex = 0;
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = PASTED_LOG_RE.exec(text)) !== null) {
    if (match.index > last) {
      const seg = text.slice(last, match.index);
      if (seg.trim()) parts.push(renderFileSegments(seg, breaks));
    }
    const chipName = match[2] ?? match[4] ?? "pasted_log.txt";
    const chipBody = match[3] ?? match[5] ?? "";
    parts.push(pastedLogChipHtml(chipName, chipBody));
    last = match.index + match[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()) parts.push(renderFileSegments(tail, breaks));
  return prefix + parts.join("");
}

// A voice-input chip: a mic glyph + "voice" label, signalling the message was
// dictated. Mirrors the attachment-chip shape.
function voiceInputChipHtml(): string {
  return `<div class="attachment-chip voice-input-chip" title="Dictated by voice"><i class="ph ph-microphone"></i><span class="chip-name">voice</span></div>`;
}

// An AUQ-answer chip: a reply glyph + "answer" label, signalling this message is
// the user's answer to a question card. The full "Q: … A: …" framing rides
// along as a data attribute (like the pasted-log chip) so clicking it reveals
// the raw text without dumping it into the transcript by default.
function auqAnswerChipHtml(rawText: string): string {
  return `<div class="attachment-chip auq-answer-chip previewable" data-auq-answer-text="${utf8ToBase64(rawText)}" title="Your answer to Claude's question - click to view"><i class="ph ph-arrow-bend-up-left"></i><span class="chip-name">answer</span></div>`;
}

// Renders a text segment, turning any <file:> tokens into attachment chips and
// the rest into markdown.
function renderFileSegments(text: string, breaks = false): string {
  FILE_TOKEN_RE.lastIndex = 0;
  if (!FILE_TOKEN_RE.test(text)) {
    FILE_TOKEN_RE.lastIndex = 0;
    return `<div class="block text">${renderMarkdown(text, breaks)}</div>`;
  }
  FILE_TOKEN_RE.lastIndex = 0;
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > last) {
      const seg = text.slice(last, match.index).trim();
      if (seg) parts.push(`<div class="block text">${renderMarkdown(seg, breaks)}</div>`);
    }
    const path = match[1] ?? "";
    const name = match[2] ?? basename(path);
    parts.push(attachmentChipHtml(path, name));
    last = match.index + match[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) parts.push(`<div class="block text">${renderMarkdown(tail, breaks)}</div>`);
  return parts.join("");
}

function attachmentChipHtml(path: string, name: string): string {
  return `<div class="attachment-chip" data-attachment-path="${escapeHtml(path)}" data-filename="${escapeHtml(name)}"><i class="ph ph-file"></i><span class="chip-name">${escapeHtml(name)}</span></div>`;
}

/** UTF-8-safe base64 (btoa is Latin1-only). Chunked to avoid arg-count limits
 * on large pastes. */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Inverse of utf8ToBase64. Returns "" on malformed input. */
export function base64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

// A pasted-log chip mirrors the composer chip: a file-text glyph + name, the
// full body stashed (base64) on the element so a click can open it in the
// lightbox without re-parsing the message.
function pastedLogChipHtml(name: string, body: string): string {
  return `<div class="attachment-chip pasted-log-chip previewable" data-pasted-name="${escapeHtml(name)}" data-pasted-text="${utf8ToBase64(body)}"><i class="ph ph-file-text"></i><span class="chip-name">${escapeHtml(name)}</span></div>`;
}

/** Builds the inline PR preview card HTML. The rendered description is
 * pre-baked into a hidden template so the modal only needs to clone it for
 * the Description tab; the commits JSON is stashed on the card itself
 * (base64, `[{sha,msg}]`, newest first) so the modal's sidebar can read it
 * directly without re-parsing rendered HTML. */
export function renderPrPreviewCard(title: string, bodyB64: string, commitsB64: string): string {
  const body = base64ToUtf8(bodyB64);
  const renderedBody = body ? renderMarkdown(body, false, true) : "<p><em>No description.</em></p>";
  return `<div class="pr-preview-card" data-pr-title="${escapeHtml(title)}" data-pr-commits="${escapeHtml(commitsB64)}"><div class="pr-card-strip"><i class="ph ph-git-pull-request"></i><span class="pr-card-label">PR ready — review before creating</span><button class="pr-preview-btn">Preview</button></div><template class="pr-modal-tpl"><div class="pr-modal-body-content"><h1 class="pr-body-title">${escapeHtml(title)}</h1>${renderedBody}</div></template></div>`;
}

export function renderBlocks(blocks: ContentBlock[], breaks = false, fileChips = false): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "text":
          return renderTextBlock(b.text, breaks, fileChips);
        case "image":
          // base64's alphabet can't contain &<>"', so escaping it (b.data can
          // be multiple MB) would scan the whole payload for zero benefit.
          return `<img class="block image" src="data:${escapeHtml(b.mime)};base64,${b.data}" alt="">`;
        default:
          ((_: never) => "")(b);
      }
    })
    .join("");
}

// is_meta system notes can carry an entire relayed message (e.g. a
// repo-channel dump), not just a short caption - collapse long ones behind
// a toggle instead of a giant wall of centered italic text.
const SYSTEM_NOTE_PREVIEW_LEN = 160;

/** Slices `text` to `maxLen` (reserving 2 chars for the appended "…") once it
 * exceeds that length; returns it unchanged otherwise. */
export function truncateForSummary(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 2) + "…" : text;
}

function renderSystemNote(text: string): string {
  if (text.length <= SYSTEM_NOTE_PREVIEW_LEN) {
    return `<div class="msg system">${escapeHtml(text)}</div>`;
  }
  const preview = escapeHtml(truncateForSummary(text, SYSTEM_NOTE_PREVIEW_LEN));
  return `<details class="msg system system-long"><summary>${preview}</summary><div class="system-note-full">${escapeHtml(text)}</div></details>`;
}

export function renderMessage(m: RenderedMessage): string {
  switch (m.kind) {
    case "system":
      if (m.compactionN != null) {
        return `<div class="msg system compact-marker"><span class="compact-chip"><i class="ph ph-stack"></i>Context compacted<span class="compact-n">×${m.compactionN}</span></span></div>`;
      }
      if (m.metaKind) {
        // Bookkeeping-only row (silentStreakBoundaryIndex etc, see
        // chat-event-handler.ts) - CSS-hidden; the visible render is the
        // inline tool-strip chip built by TurnFooterRegistry.ensureMetaChip.
        const n = m.streakCount && m.streakCount > 1 ? `<span class="compact-n">×${m.streakCount}</span>` : "";
        return `<div class="msg system meta-marker"><span class="meta-chip meta-chip--${escapeHtml(m.metaKind)}" title="${escapeHtml(m.metaDetail ?? "")}"><i class="ph ${META_KIND_ICONS[m.metaKind]}"></i>${escapeHtml(m.text ?? "")}${n}</span></div>`;
      }
      return renderSystemNote(m.streakCount && m.streakCount > 1 ? `${m.text ?? ""} ×${m.streakCount}` : (m.text ?? ""));
    case "user":
      return `<div class="msg user">${renderBlocks(m.content ?? [], true, true)}</div>`;
    case "assistant": {
      const blocks = m.content ?? [];
      const firstBlock = blocks[0];
      const isApiError = !m.streaming &&
        blocks.length === 1 &&
        firstBlock != null &&
        firstBlock.type === "text" &&
        firstBlock.text.startsWith("API Error:");
      const retryBtn = isApiError
        ? `<button class="api-retry-btn"><i class="ph ph-arrow-clockwise"></i>Retry</button>`
        : "";
      let prCard = "";
      if (!m.streaming) {
        for (const b of blocks) {
          if (b.type !== "text") continue;
          const pr = detectPrPreviewToken(b.text);
          if (pr) { prCard = renderPrPreviewCard(pr.title, pr.bodyB64, pr.commitsB64); break; }
        }
      }
      return `<div class="msg assistant${m.streaming ? " streaming" : ""}"><button class="copy-btn msg-copy-btn" aria-label="Copy message"><i class="ph ph-copy"></i></button>${renderBlocks(blocks)}${retryBtn}${prCard}</div>`;
    }
    // Explicit send_message call - same bubble shape as "assistant", sourced
    // from m.text instead of m.content (see chat-event-handler.ts tool_use).
    case "message":
      if (m.failed) {
        return `<div class="msg system failed-marker"><span class="failed-chip" title="${escapeHtml(m.text ?? "")}"><i class="ph ph-wifi-slash"></i>Failed to send</span></div>`;
      }
      if (m.retracted) {
        return `<div class="msg system retracted-marker"><span class="retracted-chip" title="${escapeHtml(m.text ?? "")}"><i class="ph ph-prohibit"></i>Retracted</span></div>`;
      }
      return `<div class="msg assistant${m.dimmed ? " dimmed" : ""}"><button class="copy-btn msg-copy-btn" aria-label="Copy message"><i class="ph ph-copy"></i></button>${renderTextBlock(m.text ?? "")}</div>`;
    case "tool_use": {
      const view = parseFileEdit(m.tool ?? "", m.input);
      if (view) return `<div class="msg tool-use tool-use--file">${renderEditWindow(view)}</div>`;
      const summary = toolSummary(m.tool ?? "", m.input);
      return `<details class="msg tool-use tool-row"><summary class="tool-row-summary"><i class="ph ${escapeHtml(summary.icon)}"></i><span class="tool-row-name">${escapeHtml(summary.tool)}</span><span class="tool-row-target">${escapeHtml(summary.target)}</span></summary><div class="copyable-block code-card"><pre>${escapeHtml(JSON.stringify(m.input ?? null, null, 2))}</pre><button class="copy-btn" aria-label="Copy"><i class="ph ph-copy"></i></button></div></details>`;
    }
    case "tool_result": {
      const hasImage = m.output?.type === "image";
      const body = m.outputTruncated
        ? `<button type="button" class="tool-result-load-full" data-tool-use-id="${escapeHtml(m.tool_use_id ?? "")}" data-seq="${m.fullSeq ?? ""}"><i class="ph ph-arrow-clockwise"></i>Load full output</button><div class="copyable-block code-card"><pre>${m.output?.type === "text" ? escapeHtml(m.output.text) : ""}</pre></div>`
        : (m.output ? renderBlocks([m.output]) : "");
      return `<details class="msg tool-result tool-row${m.is_error ? " error" : ""}"${hasImage ? " open" : ""}><summary class="tool-row-summary"><i class="ph ph-arrow-bend-down-right"></i><span class="tool-row-name">${hasImage ? "screenshot" : "result"}</span></summary>${body}</details>`;
    }
    case "notification":
      return `<div class="msg notification">${escapeHtml(m.text ?? "")}</div>`;
    default:
      return "";
  }
}

export function renderMarkdown(text: string, breaks = false, allowHtml = false): string {
  const inst = allowHtml ? mdHtml : breaks ? mdBreaks : md;
  return highlightKeywords(wrapTables(linkifyInlineCodeUrls(highlightSlashMentions(inst.render(text)), inst)));
}

export function eventToRenderedMessage(ev: ChatEvent): RenderedMessage | null {
  const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
  switch (ev.type) {
    case "session_started":
      return { kind: "system", text: `Session started${ev.model ? ` (${ev.model})` : ""}`, ts };
    case "user_message": {
      if (isCompactUserMessage(ev.content)) {
        return { kind: "system", text: "Conversation compacted", ts };
      }
      const cleaned = cleanUserBlocks(ev.content);
      if (cleaned.length === 0) return null;
      if (isResumeContinuationUserMessage(cleaned)) return null;
      if (isSilentSystemUserMessage(cleaned)) return { kind: "system", text: "Continuing session…", ts };
      if (ev.is_meta) {
        const meta = classifyMetaTurn(cleaned);
        return { kind: "system", text: meta.label, metaKind: meta.kind, metaDetail: meta.detail, ts };
      }
      return { kind: "user", content: cleaned, ts };
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

export function wrapBlockquotes(container: HTMLElement): void {
  const quotes = Array.from(
    container.querySelectorAll<HTMLElement>(".msg.assistant blockquote:not([data-wrapped])"),
  );
  for (const bq of quotes) {
    bq.dataset.wrapped = "true";
    const wrapper = document.createElement("div");
    wrapper.className = "copyable-block card-block";
    bq.parentNode!.insertBefore(wrapper, bq);
    wrapper.appendChild(bq);
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.setAttribute("aria-label", "Copy");
    btn.innerHTML = '<i class="ph ph-copy"></i>';
    wrapper.appendChild(btn);
  }
}
