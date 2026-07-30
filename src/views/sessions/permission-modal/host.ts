import "../permission-modal-shell.css";
import "../permission-modal-question.css";

export const HOST_ID = "prompt-card-host";

/**
 * Pick the best mount point for the floating card:
 * 1. Active `.session-composer` (anchors above it via `bottom: 100%`).
 * 2. `.session-pane` if no composer (e.g. read-only).
 * 3. `document.body` (fallback, fixed bottom).
 */
export function ensureHost(): { host: HTMLElement; mode: "composer" | "pane" | "viewport" } {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;

  const composer = document.querySelector<HTMLElement>(".session-composer");
  if (composer) {
    host.classList.add("prompt-card-host--composer");
    composer.appendChild(host);
    return { host, mode: "composer" };
  }
  const pane = document.querySelector<HTMLElement>(".session-pane");
  if (pane) {
    host.classList.add("prompt-card-host--pane");
    pane.appendChild(host);
    return { host, mode: "pane" };
  }
  host.classList.add("prompt-card-host--viewport");
  document.body.appendChild(host);
  return { host, mode: "viewport" };
}

export function clearHost(): void {
  document.getElementById(HOST_ID)?.remove();
}

export function renderCardShell(titleHtml: string, bodyHtml: string, footerHtml: string): string {
  return `
    <div class="prompt-card" role="dialog" aria-modal="false">
      <div class="prompt-card__header">${titleHtml}</div>
      <div class="prompt-card__body">${bodyHtml}</div>
      <div class="prompt-card__footer">${footerHtml}</div>
    </div>
  `;
}
