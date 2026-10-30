// The favourite project slots, floating over the app while Ctrl+Shift is held
// (shortcuts.ts's onModifierHint), so Ctrl+Shift+1-9 can be pressed without
// remembering which number holds which project. Reuses the Pick project rail's
// tile classes (project-picker.css) so a slot looks the same in both places.
//
// A body-level fixed overlay, not a child of the composer: the shortcut works
// on every screen, including ones with no composer, and a composer child would
// sit under the question card that floats above it.

import "./favorites-strip.css";
import { escapeHtml } from "../../shared/escape-html";
import { isAnyModalOpen } from "../../shared/modal-input-lock";
import { basename } from "../../shared/path-utils";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { isRemote } from "../../shared/transport";
import { projectGroupsData } from "./new-session-cache";
import { readFavorites, resolveFavoriteSlot } from "./project-favorites";

const STRIP_CLASS = "favorites-strip";

const findProject = (path: string) =>
  projectGroupsData().cached?.find((g) => g.path.toLowerCase() === path.toLowerCase());

function slotHtml(path: string | null, i: number): string {
  const num = `<span class="pp-num">${i + 1}</span>`;
  const resolution = resolveFavoriteSlot(path, findProject);
  if (resolution.kind === "empty") {
    return `<div class="pp-fav-slot is-empty" data-slot="${i}" style="--slot-i:${i}">${num}<span class="favorites-strip-name">empty</span></div>`;
  }
  // Same "keeps its number, goes quiet" treatment as the picker rail for a
  // slot whose project left the registry.
  const face = resolution.kind === "resolved"
    ? `<span class="pp-fav-face">${renderAvatar(resolution.project.avatar, resolution.project.path)}</span>`
    : `<i class="ph ph-question pp-fav-gone"></i>`;
  const name = escapeHtml(resolution.kind === "resolved" ? resolution.project.name : basename(resolution.path));
  return `<div class="pp-fav-slot${resolution.kind === "resolved" ? "" : " is-unresolved"}" data-slot="${i}" style="--slot-i:${i}" title="${name} - ctrl+shift+${i + 1}">${num}${face}<span class="favorites-strip-name">${name}</span></div>`;
}

const GAP_PX = 6;
const FALLBACK_BOTTOM_PX = 24;
const FALLBACK_MAX_WIDTH_PX = 900;

/** What the strip sits above, in priority order: an open question/permission
 *  card (it floats over the composer, so anchoring to the composer would hide
 *  the strip under it), the composer box, else nothing (no chat selected, the
 *  dashboard, any other view) and the strip rides the viewport bottom. */
function anchorRect(): DOMRect | null {
  for (const sel of ["#prompt-card-host .prompt-card", ".composer-shell"]) {
    const r = document.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) return r;
  }
  return null;
}

function place(strip: HTMLElement): void {
  const anchor = anchorRect();
  if (anchor) {
    strip.style.left = `${anchor.left}px`;
    strip.style.width = `${anchor.width}px`;
    strip.style.bottom = `${window.innerHeight - anchor.top + GAP_PX}px`;
    return;
  }
  const width = Math.min(FALLBACK_MAX_WIDTH_PX, window.innerWidth - 32);
  strip.style.left = `${(window.innerWidth - width) / 2}px`;
  strip.style.width = `${width}px`;
  strip.style.bottom = `${FALLBACK_BOTTOM_PX}px`;
}

/** Shows the strip over whatever screen is up. A no-op on the phone (favourites
 *  are desktop only), under a modal (the shortcut is ignored there too), or with
 *  no favourite set at all. */
export function showFavoritesStrip(onPick: (slot: number) => void): void {
  if (isRemote() || isAnyModalOpen() || document.querySelector(`.${STRIP_CLASS}`)) return;
  const slots = readFavorites();
  if (slots.every((s) => s === null)) return;

  const strip = document.createElement("div");
  strip.className = STRIP_CLASS;
  strip.innerHTML = slots.map(slotHtml).join("");
  // Keeps focus (and the caret) where it was while a tile is clicked.
  strip.addEventListener("mousedown", (e) => e.preventDefault());
  strip.addEventListener("click", (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>(".pp-fav-slot");
    if (!tile || tile.classList.contains("is-empty") || tile.classList.contains("is-unresolved")) return;
    hideFavoritesStrip();
    onPick(Number(tile.dataset.slot) + 1);
  });
  place(strip);
  document.body.appendChild(strip);
  void hydrateProjectTechIcons(strip).catch(() => {});
  void hydrateCharacterAvatars(strip).catch(() => {});
}

export function hideFavoritesStrip(): void {
  document.querySelector(`.${STRIP_CLASS}`)?.remove();
}
