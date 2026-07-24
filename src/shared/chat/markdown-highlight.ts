// Post-processing for already-rendered markdown HTML: slash-mention /
// keyword highlighting, table copy-buttons, and inline-code URL
// linkification. Split out of chat-transforms.ts (ai_todo 320) - this half
// has no shared state with the chip/message-rendering half; it only needs
// the slash registry + escapeHtml, both imported below.
import type MarkdownIt from "markdown-it";
import { escapeHtml } from "../escape-html";
import { lookupSlash, skillDetailTarget, slashKindClass } from "./slash-registry";

const TABLE_RE = /<table[\s\S]*?<\/table>/gi;
const CELL_OPEN_RE = /<(td|th)(\s[^>]*)?>/gi;
const CELL_COPY_BTN = '<button class="copy-btn cell-copy-btn" aria-label="Copy cell"><i class="ph ph-copy"></i></button>';

export function wrapTables(html: string): string {
  return html.replace(TABLE_RE, (t) => {
    const withBtns = t.replace(CELL_OPEN_RE, (m) => `${m}${CELL_COPY_BTN}`);
    return `<div class="table-wrap"><button class="table-fs-btn" aria-label="Fullscreen table"><i class="ph ph-arrows-out"></i></button>${withBtns}</div>`;
  });
}

// markdown-it linkifies bare URLs in normal text, but a URL the model wraps in
// `inline code` renders as a non-clickable <code> span. When an inline-code
// span IS a single whole URL, wrap its contents in an anchor so it's clickable
// too — the global interceptor (shared/external-links.ts) opens it externally.
// Only whole-span URLs are linked, so a snippet like `curl https://x && y`
// stays untouched and copyable. Fenced blocks render as <pre><code> (or
// <code class="...">) and are excluded by the lookbehind / no-attribute match.
const INLINE_CODE_URL_RE = /(?<!<pre>)<code>([^<]+)<\/code>/g;

export function linkifyInlineCodeUrls(html: string, inst: MarkdownIt): string {
  return html.replace(INLINE_CODE_URL_RE, (full: string, inner: string) => {
    const matches = inst.linkify.match(inner);
    if (!matches || matches.length !== 1) return full;
    const m = matches[0]!;
    if (m.index !== 0 || m.lastIndex !== inner.length) return full;
    return `<code><a href="${escapeHtml(m.url)}">${inner}</a></code>`;
  });
}

// Wrap `/word` tokens in <span class="slash-mention slash-<kind>"> when the
// name is in the shared slash registry. Only matches outside <a>/<code>/<pre>
// (markdown-it already escapes user HTML, so we walk the rendered string at
// the text-node level using a tag-skipping regex). Unknown names stay plain.
const SLASH_MENTION_RE = /(^|[\s(>])\/([a-zA-Z][\w-]*(?::[a-zA-Z][\w-]*)?)\b/g;

const ULTRATHINK_RE = /\b(ultrathink)\b/gi;

export function highlightKeywords(html: string): string {
  const parts = html.split(/(<(?:code|pre|a)(?:\s[^>]*)?>[\s\S]*?<\/(?:code|pre|a)>)/gi);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue;
    const part = parts[i];
    if (!part) continue;
    parts[i] = part.replace(ULTRATHINK_RE, '<span class="rainbow-keyword">$1</span>');
  }
  return parts.join("");
}

export function highlightSlashMentions(html: string): string {
  // Skip content inside <code>, <pre>, <a>. Split on these tags and only
  // transform the chunks that are outside.
  const parts = html.split(/(<(?:code|pre|a)(?:\s[^>]*)?>[\s\S]*?<\/(?:code|pre|a)>)/gi);
  for (let i = 0; i < parts.length; i++) {
    // Even indices are outside the protected tags; odd indices are matches.
    if (i % 2 === 1) continue;
    const part = parts[i];
    if (!part) continue;
    parts[i] = part.replace(SLASH_MENTION_RE, (_match, pre: string, raw: string) => {
      const hit = lookupSlash(raw);
      if (!hit) return `${pre}/${raw}`;
      const cls = `slash-mention slash-${slashKindClass(hit.source)}`;
      const target = skillDetailTarget(hit.name, hit.source);
      const targetAttr = target ? ` data-skill-target="${escapeHtml(target)}"` : "";
      return `${pre}<span class="${cls}" data-slash="${escapeHtml(raw)}"${targetAttr}>/${escapeHtml(raw)}</span>`;
    });
  }
  return parts.join("");
}

/**
 * Highlight known `/slash` tokens in RAW composer text (not markdown) for the
 * composer's highlight backdrop. Escapes HTML and wraps registered commands in
 * a COLOR-ONLY span; unknown names stay plain. The span must not change font,
 * padding, or border - the backdrop sits glyph-for-glyph behind a transparent
 * textarea, so any box change would knock the text out of alignment.
 */
export function highlightComposerInput(text: string): string {
  const escaped = escapeHtml(text);
  const withSpans = escaped.replace(SLASH_MENTION_RE, (_match, pre: string, raw: string) => {
    const hit = lookupSlash(raw);
    if (!hit) return `${pre}/${raw}`;
    return `${pre}<span class="cm-slash cm-slash-${slashKindClass(hit.source)}">/${raw}</span>`;
  });
  // pre-wrap drops a trailing newline; pad it so the backdrop height (and thus
  // scroll position) tracks the textarea exactly.
  const padded = withSpans.endsWith("\n") ? withSpans + " " : withSpans;
  return highlightKeywords(padded);
}
