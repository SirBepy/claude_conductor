import "../permission-modal-shell.css";
import "../permission-modal-question.css";
import "../permission-modal-summary.css";
import "../permission-modal-badges.css";
import { attachDragHandle } from "./drag-handle";
import { dismissQuestionCard } from "./question-state";
import { isMobileViewport } from "../../../shared/mobile-viewport";

export const HOST_ID = "prompt-card-host";

// permission-modal-shell.css's two `@media (max-width: 768px)` blocks are the
// CSS twin of isMobileViewport() - keep that breakpoint in sync.
const HEADER_GAP = 8; // px of breathing room below the header's bottom edge

let _detachDrag: (() => void) | null = null;
let _resizeHandler: (() => void) | null = null;

// Caps the card's mobile max-height below .session-header's bottom edge (the
// project name must stay visible). sessions.css owns that dynamic box model,
// so the live header is measured instead of guessed here in CSS.
function applyMobileHeightCap(host: HTMLElement, mode: "composer" | "pane" | "viewport"): void {
  if (!isMobileViewport()) { host.style.removeProperty("--prompt-card-max-h"); return; }
  const header = document.querySelector<HTMLElement>(".session-header");
  if (!header) { host.style.removeProperty("--prompt-card-max-h"); return; }
  const headerBottom = header.getBoundingClientRect().bottom;
  // Composer mode grows the card upward from the composer's own top edge;
  // pane/viewport modes anchor from the bottom of the viewport instead.
  const topAnchor = mode === "composer" ? host.parentElement!.getBoundingClientRect().top : window.innerHeight;
  const available = topAnchor - headerBottom - HEADER_GAP;
  host.style.setProperty("--prompt-card-max-h", `${Math.max(160, available)}px`);
}

/**
 * Pick the best mount point for the floating card:
 * 1. Active `.session-composer` (anchors above it via `bottom: 100%`).
 * 2. `.session-pane` if no composer (e.g. read-only).
 * 3. `document.body` (fallback, fixed bottom).
 */
export function ensureHost(): { host: HTMLElement; mode: "composer" | "pane" | "viewport" } {
  // Every swap tears the outgoing question card down first. Yanking only its
  // DOM left the card's document-level keydown/visibilitychange handlers live,
  // so a retried tool call or a second prompt could cancel a stale prompt id.
  dismissQuestionCard();
  document.getElementById(HOST_ID)?.remove();
  _detachDrag?.();
  if (_resizeHandler) window.removeEventListener("resize", _resizeHandler);

  const host = document.createElement("div");
  host.id = HOST_ID;

  let mode: "composer" | "pane" | "viewport";
  const composer = document.querySelector<HTMLElement>(".session-composer");
  const pane = document.querySelector<HTMLElement>(".session-pane");
  if (composer) {
    host.classList.add("prompt-card-host--composer");
    composer.appendChild(host);
    mode = "composer";
  } else if (pane) {
    host.classList.add("prompt-card-host--pane");
    pane.appendChild(host);
    mode = "pane";
  } else {
    host.classList.add("prompt-card-host--viewport");
    document.body.appendChild(host);
    mode = "viewport";
  }

  applyMobileHeightCap(host, mode);
  _resizeHandler = () => applyMobileHeightCap(host, mode);
  window.addEventListener("resize", _resizeHandler);
  _detachDrag = attachDragHandle(host);

  return { host, mode };
}

export function clearHost(): void {
  _detachDrag?.();
  _detachDrag = null;
  if (_resizeHandler) { window.removeEventListener("resize", _resizeHandler); _resizeHandler = null; }
  document.getElementById(HOST_ID)?.remove();
}

// .prompt-card__answer-bar sits inside the footer row (flex:1, next to
// Skip/Next) - stable mount point for question-ui-render.ts's syncAnswerBar().
export function renderCardShell(titleHtml: string, bodyHtml: string, footerHtml: string): string {
  return `
    <div class="prompt-card" role="dialog" aria-modal="false">
      <div class="prompt-card__handle" aria-hidden="true"></div>
      <div class="prompt-card__header">${titleHtml}</div>
      <div class="prompt-card__body">${bodyHtml}</div>
      <div class="prompt-card__footer">
        <div class="prompt-card__answer-bar"></div>
        ${footerHtml}
      </div>
    </div>
  `;
}
