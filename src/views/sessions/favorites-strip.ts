// The favourite project slots, shown inside the composer box while Ctrl+Shift
// is held (shortcuts.ts's onModifierHint), so Ctrl+Shift+1-9 can be pressed
// without remembering which number holds which project. Reuses the Pick
// project rail's tile classes (project-picker.css) so a slot looks the same
// in both places.
//
// Inserted on show and removed on hide rather than kept in the composer:
// active-session.ts rebuilds the pane's markup on every chat switch.

import "./favorites-strip.css";
import { escapeHtml } from "../../shared/escape-html";
import { isAnyModalOpen } from "../../shared/modal-input-lock";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { isRemote } from "../../shared/transport";
import { projectGroupsData } from "./new-session-cache";
import { readFavorites } from "./project-favorites";

const STRIP_CLASS = "favorites-strip";

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function slotHtml(path: string | null, i: number): string {
  const num = `<span class="pp-num">${i + 1}</span>`;
  if (path === null) {
    return `<div class="pp-fav-slot is-empty" data-slot="${i}">${num}<span class="favorites-strip-name">empty</span></div>`;
  }
  const p = projectGroupsData().cached?.find((g) => g.path.toLowerCase() === path.toLowerCase());
  // Same "keeps its number, goes quiet" treatment as the picker rail for a
  // slot whose project left the registry.
  const face = p
    ? `<span class="pp-fav-face">${renderAvatar(p.avatar, p.path)}</span>`
    : `<i class="ph ph-question pp-fav-gone"></i>`;
  const name = escapeHtml(p?.name ?? baseName(path));
  return `<div class="pp-fav-slot${p ? "" : " is-unresolved"}" data-slot="${i}" title="${name} - ctrl+shift+${i + 1}">${num}${face}<span class="favorites-strip-name">${name}</span></div>`;
}

/** Shows the strip in `pane`'s composer. A no-op on the phone (favourites are
 *  desktop only), under a modal (the shortcut is ignored there too), with no
 *  favourite set at all, or with no composer on screen. */
export function showFavoritesStrip(pane: HTMLElement, onPick: (slot: number) => void): void {
  if (isRemote() || isAnyModalOpen()) return;
  const shell = pane.querySelector<HTMLElement>(".composer-shell");
  const composer = shell?.querySelector<HTMLElement>(".session-composer");
  if (!shell || !composer || shell.querySelector(`.${STRIP_CLASS}`)) return;
  const slots = readFavorites();
  if (slots.every((s) => s === null)) return;

  const strip = document.createElement("div");
  strip.className = STRIP_CLASS;
  strip.innerHTML = slots.map(slotHtml).join("");
  // Keeps focus (and the caret) in the composer while a tile is clicked.
  strip.addEventListener("mousedown", (e) => e.preventDefault());
  strip.addEventListener("click", (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>(".pp-fav-slot");
    if (!tile || tile.classList.contains("is-empty") || tile.classList.contains("is-unresolved")) return;
    hideFavoritesStrip(pane);
    onPick(Number(tile.dataset.slot) + 1);
  });
  shell.insertBefore(strip, composer);
  void hydrateProjectTechIcons(strip).catch(() => {});
  void hydrateCharacterAvatars(strip).catch(() => {});
}

export function hideFavoritesStrip(pane: HTMLElement): void {
  pane.querySelector(`.${STRIP_CLASS}`)?.remove();
}
