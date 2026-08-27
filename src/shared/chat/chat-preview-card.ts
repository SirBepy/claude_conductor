// The `show_preview` card: a pushed HTML document as its own centered message
// row, replacing the `<cc-preview:SLUG>` sentinel as the in-chat push path.
// The rail still owns the big canvas, device widths and history; ⤢ goes there.

import { invoke } from "../ipc";
import type { RenderedMessage } from "./chat-classifiers";
import { escapeHtml } from "../escape-html";
import { asObj, strField } from "../obj-utils";
import { buildPreviewDocumentHtml } from "../../views/sessions/preview-panel-document";

/** Fired on `window` when a card's ⤢ is clicked; the sessions view listens and
 *  hands the slug to the rail. `detail: { slug }`. */
export const PREVIEW_OPEN_EVENT = "cc-preview-open";

/** `PreviewSnapshot.source` for a `show_preview` push (mirrors the Rust
 *  `PREVIEW_SOURCE_CHAT_CARD`). These already render inline, so the rail must
 *  not force itself open for them. */
export const PREVIEW_SOURCE_CHAT_CARD = "chat_card";

/** Title derived from a slug when the push omitted one, matching the Rust
 *  side's `preview_title_from_slug` so both paths label a card the same. */
export function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The `kind:"preview"` row's own fields, read off the tool_use input. Shared
 *  by the live and scrollback paths so the two can never drift. */
export function previewFieldsOf(input: unknown): Pick<RenderedMessage, "text" | "previewHtml" | "previewSlug"> {
  const o = asObj(input);
  const slug = strField(o, "slug");
  const title = strField(o, "title").trim();
  return {
    text: title || titleFromSlug(slug) || "Preview",
    previewHtml: strField(o, "html"),
    previewSlug: slug,
  };
}

/** Card markup. The frame starts empty - `mountPreviewFrame` fills its src
 *  once the daemon has staged the document (async, so it cannot happen here). */
export function renderPreviewCardHtml(m: RenderedMessage): string {
  const title = escapeHtml(m.text ?? "Preview");
  const slug = escapeHtml(m.previewSlug ?? "");
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
 *  `render_preview_doc` round-trip the rail uses. */
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
