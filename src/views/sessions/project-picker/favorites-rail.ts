// The favourites rail (placement P4: inline in the Pick-project footer) and
// its drag gestures. Split out of project-picker.ts (todo 985) once the view
// file passed ~300 lines again - drop semantics stay in project-favorites.ts
// (pure, unit-tested); this only wires the gestures and the rail/hint markup
// to them. project-picker.ts is the only caller; it owns `favorites`,
// `projectByPath`, `openFavorite` and `renderModal`, passed in via `deps`
// (same render+attach split machine-field.ts already uses) since this module
// must mutate drag/hover state that project-picker.ts's own row-hover
// handlers and hint positioning also read.
//
// Pointer events, not HTML5 drag-and-drop: Tauri's native file-drop handler
// (on by default, and the path that drops files into the chat composer) owns
// the Windows webview's drop target, so an in-page drag never gets
// dragover/drop - the cursor just shows no-drop. Synthetic DragEvents in the
// view harness passed regardless, which is how two earlier fixes shipped
// without working.

import { html, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { isRemote } from "../../../shared/transport";
import type { ProjectGroup } from "../../../types/ipc.generated";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../../shared/projects";
import {
  SLOT_COUNT,
  type FavoriteSlots,
  assignSlot,
  moveSlot,
  clearSlot,
  resolveFavoriteSlot,
} from "../project-favorites";

/** Drag/hover state for the rail, owned by project-picker.ts and passed in
 *  by reference so mutations here (drag) and in project-picker.ts (row
 *  hover, hint positioning) stay visible to each other. */
export interface FavoritesRailState {
  dragOverSlot: number | null;
  hoverFavSlot: number | null;
}

export interface FavoritesRailDeps {
  /** Always re-read live - `favorites` is reassigned on every persist, and a
   *  drag spans multiple renders, so a snapshot captured at drag-start would
   *  go stale. */
  getFavorites: () => FavoriteSlots;
  projectByPath: (path: string) => ProjectGroup | undefined;
  openFavorite: (path: string) => boolean;
  persistFavorites: (next: FavoriteSlots) => void;
  renderModal: () => void;
  isMachineActive: () => boolean;
  isResolved: () => boolean;
}

// Drop semantics live in project-favorites.ts; this only wires the gestures
// to them. A tile released anywhere that is NOT another tile is the remove
// gesture.
export function startFavoriteDrag(
  state: FavoritesRailState,
  deps: FavoritesRailDeps,
  e: PointerEvent,
  payload: { kind: "row"; path: string } | { kind: "slot"; index: number },
): void {
  if (e.button !== 0 || isRemote() || deps.isMachineActive()) return;
  // Stops text selection and focus theft (the search box keeps its caret);
  // the click that follows a no-move press still fires.
  e.preventDefault();
  const { pointerId, clientX: startX, clientY: startY } = e;
  let ghost: HTMLElement | null = null;

  const slotAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".pp-fav-slot");
    return el?.dataset.slot !== undefined ? Number(el.dataset.slot) : null;
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      const favorites = deps.getFavorites();
      const path = payload.kind === "row" ? payload.path : favorites[payload.index];
      const p = path ? deps.projectByPath(path) : undefined;
      ghost = document.createElement("div");
      ghost.className = "pp-drag-ghost";
      ghost.innerHTML = p
        ? `<span class="pp-fav-face">${renderAvatar(p.avatar, p.path)}</span>`
        : "";
      if (p) ghost.append(p.name);
      document.body.append(ghost);
      document.body.classList.add("pp-dragging");
      void hydrateProjectTechIcons(ghost);
      void hydrateCharacterAvatars(ghost);
    }
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    const over = slotAt(ev.clientX, ev.clientY);
    if (over !== state.dragOverSlot) { state.dragOverSlot = over; deps.renderModal(); }
  };

  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("pp-dragging");
    state.dragOverSlot = null;
    // A release over the row it started on would otherwise click it and
    // open that project.
    const swallow = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (deps.isResolved()) return;
    const target = ev.type === "pointerup" ? slotAt(ev.clientX, ev.clientY) : null;
    const favorites = deps.getFavorites();
    if (target !== null) {
      deps.persistFavorites(payload.kind === "row"
        ? assignSlot(favorites, target, payload.path)
        : moveSlot(favorites, payload.index, target));
    } else if (payload.kind === "slot" && ev.type === "pointerup") {
      deps.persistFavorites(clearSlot(favorites, payload.index));
    } else {
      deps.renderModal();
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

export function renderFavoriteRail(state: FavoritesRailState, deps: FavoritesRailDeps): TemplateResult | "" {
  if (isRemote() || deps.isMachineActive()) return "";
  const favorites = deps.getFavorites();
  return html`
    <div class="pp-fav-rail" role="group" aria-label="Favourite projects, keys ctrl+1 to ctrl+9">
      ${Array.from({ length: SLOT_COUNT }, (_, i) => {
        const path = favorites[i] ?? null;
        // Same resolve as the composer's Ctrl+Shift strip (project-favorites.ts):
        // a slot whose project left the registry keeps its number and goes
        // quiet rather than vanishing, since silently renumbering everything
        // would repoint every key below it.
        const resolution = resolveFavoriteSlot(path, deps.projectByPath);
        const label = resolution.kind === "resolved" ? resolution.project.name
          : (resolution.kind === "unresolved" ? "(missing)" : `Empty slot ${i + 1}`);
        return html`
          <div
            class="pp-fav-slot${resolution.kind === "empty" ? " is-empty" : ""}${resolution.kind === "unresolved" ? " is-unresolved" : ""}${state.dragOverSlot === i ? " is-target" : ""}${state.hoverFavSlot === i && state.dragOverSlot === null ? " is-hinted" : ""}"
            data-slot=${i}
            title=${resolution.kind === "resolved" ? `${resolution.project.name} - press ctrl+${i + 1}` : (resolution.kind === "unresolved" ? resolution.path : `Empty - drag a project here for ctrl+${i + 1}`)}
            aria-label=${label}
            @click=${() => { if (path) deps.openFavorite(path); }}
            @pointerdown=${(e: PointerEvent) => {
              if (path !== null) startFavoriteDrag(state, deps, e, { kind: "slot", index: i });
            }}
          >
            <span class="pp-num">${i + 1}</span>
            ${resolution.kind === "resolved"
              ? html`<span class="pp-fav-face">${unsafeHTML(renderAvatar(resolution.project.avatar, resolution.project.path))}</span>`
              : (resolution.kind === "unresolved" ? html`<i class="ph ph-question pp-fav-gone"></i>` : "")}
          </div>
        `;
      })}
    </div>
  `;
}

/** The ctrl+N tooltip for the hovered tile. A drag paints its own target, so
 *  the hover hint goes quiet while one is in flight. */
export function renderFavoriteHint(state: FavoritesRailState): TemplateResult | "" {
  const hintSlot = document.body.classList.contains("pp-dragging") ? null : state.hoverFavSlot;
  return hintSlot !== null ? html`<div class="pp-fav-hint">Ctrl ${hintSlot + 1}</div>` : "";
}

/** Positions the hint rendered by renderFavoriteHint - a sibling of the
 *  modal card rather than a child, because the card's overflow:hidden would
 *  clip a tooltip hanging below its bottom edge. Call after the render that
 *  painted `renderFavoriteHint`'s output into `slot`. */
export function positionFavoriteHint(slot: HTMLElement, host: HTMLElement, state: FavoritesRailState): void {
  const hintSlot = document.body.classList.contains("pp-dragging") ? null : state.hoverFavSlot;
  const hint = slot.querySelector<HTMLElement>(".pp-fav-hint");
  const hintTile = hintSlot !== null ? host.querySelector<HTMLElement>(`.pp-fav-slot[data-slot="${hintSlot}"]`) : null;
  if (hint && hintTile) {
    const r = hintTile.getBoundingClientRect();
    hint.style.left = `${r.left + r.width / 2}px`;
    hint.style.top = `${r.bottom + 6}px`;
  } else if (hint) {
    // No rail (phone, or a peer machine's list) means nothing to point at.
    hint.style.display = "none";
  }
}
