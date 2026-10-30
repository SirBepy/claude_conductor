// An image tool_result whose base64 `read_page` left out of a history page
// (history_page.rs IMAGE_INLINE_MAX_B64): `output` is an image with empty
// `data`, flagged `outputTruncated`, and `fullSeq` is the key
// `load_event_detail` fetches the real bytes by. Pure markup + predicates
// only; the fetching lives in elided-image-loader.ts so screenshot-row.ts can
// import this without a cycle.

import type { RenderedMessage } from "./chat-classifiers";
import { escapeHtml } from "../escape-html";
import { formatBytes } from "../formatters";

export interface ElidedImageRef {
  toolUseId: string;
  /** `load_event_detail`'s lookup key (the transcript line's byte offset). */
  seq: number;
  mime: string;
  /** Approximate decoded size, when the backend reported it. */
  bytes?: number;
  /** `/respawn` predecessor whose transcript holds the line, when not the open chat's. */
  originSessionId?: string;
}

/** The ref for a tool_result message whose image was elided, else null. */
export function elidedRefOf(
  m: Pick<RenderedMessage, "output" | "outputTruncated" | "fullSeq" | "outputBytes" | "tool_use_id" | "originSessionId">,
): ElidedImageRef | null {
  const out = m.output;
  if (!out || out.type !== "image" || out.data !== "" || !m.outputTruncated) return null;
  if (m.fullSeq === undefined || !m.tool_use_id) return null;
  return {
    toolUseId: m.tool_use_id,
    seq: m.fullSeq,
    mime: out.mime,
    bytes: m.outputBytes,
    originSessionId: m.originSessionId,
  };
}

/** The data-* attributes the loader and the click handler read back. */
export function elidedAttrs(ref: ElidedImageRef): string {
  const origin = ref.originSessionId ? ` data-origin-session="${escapeHtml(ref.originSessionId)}"` : "";
  return `data-elided-image="1" data-tool-use-id="${escapeHtml(ref.toolUseId)}" data-seq="${ref.seq}"${origin}`;
}

export function elidedLabel(ref: ElidedImageRef): string {
  return ref.bytes !== undefined ? `${ref.mime}, ${formatBytes(ref.bytes)}` : ref.mime;
}

/** The inline stand-in for a tool_result row's image: a box that loads the
 *  real image when it scrolls into view, or on click if that failed. */
export function elidedRowHtml(ref: ElidedImageRef): string {
  return `<div class="elided-image" ${elidedAttrs(ref)} role="button" tabindex="0"><i class="ph ph-image"></i><span class="elided-image-label">${escapeHtml(elidedLabel(ref))}</span></div>`;
}
