// Gallery lightbox for a turn's screenshot row (turn-collapse.ts's
// screenshot-block). Separate from lightbox.ts's openLightbox (single image,
// no concept of "next") - this one shows a title+counter header, prev/next
// chevrons pinned to the SCREEN's own edges (not the image's), and left/right
// arrow-key navigation, both clamped at the ends (no wraparound). Reuses the
// real .lightbox-overlay/.lightbox-close chrome; chat-overlays.css overrides
// .lightbox-close's positioning when it's inside the gallery header so it
// lands inline with the title/tag/counter instead of sitting lower than them.

import { escapeHtml } from "../escape-html";
import { setupImageZoomPan } from "./image-zoom-pan";

/** One screenshot surfaced from a turn's tool_result image outputs. */
export interface ScreenshotShot {
  /** tool_use id whose result produced this screenshot. */
  toolUseId: string;
  mime: string;
  /** base64-encoded image bytes. */
  data: string;
  /** Short label shown as the gallery header title + thumbnail title attr. */
  title: string;
  /** "main" for a top-level call, "sub" for any subagent's call (styling hook). */
  agentKind: "main" | "sub";
  /** Corner-tag text on the inline thumbnail: "Main" or "Sub N". */
  agentTag: string;
  /** Full label for the gallery header chip: "Main agent" or "Subagent N". */
  agentLabel: string;
}

let overlay: HTMLDivElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let disposeZoomPan: (() => void) | null = null;

export function closeScreenshotGallery(): void {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
  disposeZoomPan?.();
  disposeZoomPan = null;
}

export function openScreenshotGallery(shots: ScreenshotShot[], startIndex: number): void {
  closeScreenshotGallery();
  if (shots.length === 0) return;
  let idx = Math.min(Math.max(startIndex, 0), shots.length - 1);

  overlay = document.createElement("div");
  overlay.className = "lightbox-overlay screenshot-gallery-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeScreenshotGallery();
  });

  // Header pins to the overlay's (screen's) own top edge and the chevrons pin
  // to its left/right edges - all independent of the centered image below,
  // which sits inside the overlay's own flex-centering (see .screenshot-gallery-*
  // rules in chat-overlays.css).
  const header = document.createElement("div");
  header.className = "screenshot-gallery-header";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "screenshot-gallery-nav screenshot-gallery-nav--prev";
  prevBtn.setAttribute("aria-label", "Previous screenshot");
  prevBtn.innerHTML = '<i class="ph ph-caret-left"></i>';
  prevBtn.addEventListener("click", () => {
    if (idx > 0) { idx--; render(); }
  });

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "screenshot-gallery-nav screenshot-gallery-nav--next";
  nextBtn.setAttribute("aria-label", "Next screenshot");
  nextBtn.innerHTML = '<i class="ph ph-caret-right"></i>';
  nextBtn.addEventListener("click", () => {
    if (idx < shots.length - 1) { idx++; render(); }
  });

  const stage = document.createElement("div");
  stage.className = "screenshot-gallery-stage";

  overlay.appendChild(header);
  overlay.appendChild(prevBtn);
  overlay.appendChild(stage);
  overlay.appendChild(nextBtn);
  document.body.appendChild(overlay);

  function render(): void {
    const shot = shots[idx]!;
    header.innerHTML = `
      <span class="screenshot-gallery-title">${escapeHtml(shot.title)}</span>
      <div class="screenshot-gallery-header-right">
        <span class="screenshot-gallery-agent" data-agent="${shot.agentKind}"><i class="ph ph-robot"></i>${escapeHtml(shot.agentLabel)}</span>
        <span class="screenshot-gallery-counter">${idx + 1} of ${shots.length}</span>
        <button type="button" class="lightbox-close" aria-label="Close preview"><i class="ph ph-x"></i></button>
      </div>
    `;
    header.querySelector(".lightbox-close")?.addEventListener("click", closeScreenshotGallery);
    disposeZoomPan?.();
    // base64's alphabet can't contain &<>"', so escaping shot.data (can be
    // multiple MB) would scan the whole payload for zero benefit.
    stage.innerHTML = `<img src="data:${escapeHtml(shot.mime)};base64,${shot.data}" alt="${escapeHtml(shot.title)}">`;
    const img = stage.querySelector("img");
    disposeZoomPan = img ? setupImageZoomPan(img, stage) : null;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === shots.length - 1;
  }

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeScreenshotGallery();
    else if (e.key === "ArrowLeft" && idx > 0) { idx--; render(); }
    else if (e.key === "ArrowRight" && idx < shots.length - 1) { idx++; render(); }
  };
  document.addEventListener("keydown", keyHandler);
  render();
}
