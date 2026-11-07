// The `show_preview` card: a pushed HTML document as its own centered message
// row, replacing the `<cc-preview:SLUG>` sentinel as the in-chat push path.
// The rail still owns the big canvas, device widths and history; ⤢ goes there.

import { invoke } from "../ipc";
import type { ContentBlock } from "../../types/ipc.generated";
import type { RenderedMessage } from "./chat-classifiers";
import { escapeHtml } from "../escape-html";
import { asObj, strField } from "../obj-utils";
import { titleCaseWords } from "../formatters";
import { buildPreviewDocumentHtml } from "../../views/sessions/preview-panel-document";

/** Fired on `window` when a card's ⤢ is clicked; the sessions view listens and
 *  hands the slug to the rail. `detail: { slug }`. */
export const PREVIEW_OPEN_EVENT = "cc-preview-open";

/** `PreviewSnapshot.source` for a `show_preview` push (mirrors the Rust
 *  `PREVIEW_SOURCE_CHAT_CARD`). These already render inline, so the rail must
 *  not force itself open for them. */
export const PREVIEW_SOURCE_CHAT_CARD = "chat_card";

/** The `kind:"preview"` row's own fields, read off the tool_use input. Shared
 *  by the live and scrollback paths so the two can never drift. */
export function previewFieldsOf(input: unknown): Pick<RenderedMessage, "text" | "previewHtml" | "previewSlug"> {
  const o = asObj(input);
  const slug = strField(o, "slug");
  const title = strField(o, "title").trim();
  return {
    text: title || titleCaseWords(slug) || "Preview",
    previewHtml: strField(o, "html"),
    previewSlug: slug,
  };
}

/** Index of the card a push for `slug` replaces in this chat's rows, or -1.
 *  Rows are per chat, so another chat's card is never touched. A slugless push
 *  has no identity to match on and always gets its own card. */
export function previewCardIndex(messages: readonly RenderedMessage[], slug: string | undefined): number {
  if (!slug) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "preview" && m.previewSlug === slug) return i;
  }
  return -1;
}

/** The row `next` becomes when it replaces `prev`: `next`'s content in `prev`'s
 *  place in the transcript (the tool promises an in-place replace), with
 *  `prev`'s own timestamp so the row stays ordered among its neighbours. The
 *  replaced version is kept, because the push is painted from its input before
 *  the daemon answers and a refusal must not cost the user the last good card. */
export function supersedePreview(prev: RenderedMessage, next: RenderedMessage): RenderedMessage {
  // A refused card has nothing worth falling back to.
  const kept = prev.previewFailed !== undefined
    ? []
    : [...(prev.previewPrev ?? []), { id: prev.id ?? "", text: prev.text ?? "", html: prev.previewHtml ?? "" }];
  return { ...next, ts: prev.ts, previewPrev: kept.length > 0 ? kept : undefined };
}

/** Index of the card a show_preview `toolUseId` is the current or a replaced
 *  version of, or -1. */
export function previewRowOfToolUse(messages: readonly RenderedMessage[], toolUseId: string): number {
  return messages.findIndex((m) => m.kind === "preview" && (m.id === toolUseId || m.previewPrev?.some((v) => v.id === toolUseId)));
}

/** The error text of a refused show_preview, short enough for a card body. */
export function previewRefusalReason(output: ContentBlock | undefined): string {
  const text = output && output.type === "text" ? output.text.trim().replace(/\s+/g, " ") : "";
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** `row` after the daemon refused the show_preview `toolUseId`. The card is
 *  built from the tool input before the answer, so without this a refused push
 *  stays on screen as an iframe at a render id the daemon does not hold: a
 *  blank white box. A refusal of a re-push falls back to the last accepted
 *  version instead, so a bad retry never costs the card that was working. */
export function refusePreview(row: RenderedMessage, toolUseId: string, reason: string): RenderedMessage {
  const prev = row.previewPrev ?? [];
  if (row.id !== toolUseId) {
    // A replaced version's push was refused: just forget it.
    return { ...row, previewPrev: prev.filter((v) => v.id !== toolUseId) };
  }
  const last = prev[prev.length - 1];
  if (last) {
    return { ...row, id: last.id, text: last.text, previewHtml: last.html, previewPrev: prev.length > 1 ? prev.slice(0, -1) : undefined };
  }
  return { ...row, previewHtml: "", previewPrev: undefined, previewFailed: reason || "the daemon refused it" };
}

/** Card markup. The frame starts empty - `mountPreviewFrame` fills its src
 *  once the daemon has staged the document (async, so it cannot happen here). */
export function renderPreviewCardHtml(m: RenderedMessage): string {
  const title = escapeHtml(m.text ?? "Preview");
  const slug = escapeHtml(m.previewSlug ?? "");
  // No frame and no panel button: nothing was staged, so there is nothing to
  // show or to open, and the reason is the only thing worth reading.
  if (m.previewFailed !== undefined) {
    return `<div class="pc-summary" data-preview-toggle>`
      + `<i class="ph ph-monitor-play"></i>`
      + `<span class="pc-label">${title}</span>`
      + `<i class="ph ph-caret-down pc-chevron"></i>`
      + `</div>`
      + `<div class="pc-body"><div class="pc-failed"><i class="ph ph-warning-circle"></i><span>Preview was not accepted: ${escapeHtml(m.previewFailed)}</span></div></div>`;
  }
  return `<div class="pc-summary" data-preview-toggle>`
    + `<i class="ph ph-monitor-play"></i>`
    + `<span class="pc-label">${title}</span>`
    + `<button type="button" class="pc-pop" data-preview-pop="${slug}" title="Open in the preview panel"><i class="ph ph-arrows-out-simple"></i><span class="pc-pop-label">Open in panel</span></button>`
    + `<i class="ph ph-caret-down pc-chevron"></i>`
    + `</div>`
    + `<div class="pc-body"><iframe class="pc-frame" sandbox="allow-scripts"></iframe></div>`
    + `<div class="pc-foot"><i class="ph ph-shield-check"></i><span>sandboxed</span><span class="pc-foot-grow"></span><span class="pc-foot-hint">drag edge to resize</span></div>`;
}

/** Stage the pushed document and point the card's iframe at it - the same
 *  `render_preview_doc` round-trip preview-panel.ts's renderIframe uses.
 *  Guards re-entry via `dataset.mounted`, unlike renderIframe, which
 *  rebuilds its canvas fresh every time and needs no such guard. */
export async function mountPreviewFrame(el: HTMLElement, m: RenderedMessage): Promise<void> {
  const iframe = el.querySelector<HTMLIFrameElement>(".pc-frame");
  if (!iframe || !m.previewHtml) return;
  if (iframe.dataset.mounted === "1") return;
  iframe.dataset.mounted = "1";
  try {
    iframe.src = await invoke<string>("render_preview_doc", { html: buildPreviewDocumentHtml(m.previewHtml) });
  } catch (err) {
    console.error("[preview-card] render failed", err);
    const body = el.querySelector<HTMLElement>(".pc-body");
    if (body) {
      body.innerHTML = `<div class="pc-failed"><i class="ph ph-warning-circle"></i><span>Preview failed to render</span></div>`;
    }
  }
}
