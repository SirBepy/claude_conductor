// Character-picker sub-feature for the new-chat modal (ai_todo 184). Split out
// of model-effort-modal.ts once that file's character-pane section grew large
// enough to warrant its own module, mirroring the earlier account-field.ts
// extraction from the same file. model-effort-modal.ts is the only caller; it
// owns the returned CharacterPane and renders/reads it in its own closure.

import { escapeHtml } from "../../shared/escape-html";
import { api } from "../../shared/api";
import type { Character } from "../../shared/api";
import { openChangeCharacterModal } from "../../shared/change-character-modal";
import { playCharacterSelectSound, cancelCharacterSelectSound } from "../../shared/character-select-sound";
import { state } from "./state";
import { characterForSession } from "./session-characters";
import { whitelistCharsData } from "./new-session-cache";

/** Cancel any pending debounced "select" sound - call when the owning modal closes. */
export function cancelCharacterPaneSound(): void {
  cancelCharacterSelectSound();
}

export interface CharacterPane {
  /** Re-render `.me-char-pane` from current state. Call after every
   * `renderBody()` in the owning modal, since that rebuilds the overlay's
   * innerHTML (and with it, the empty `.me-char-pane` div this renders into). */
  render(): void;
  /** Kick off the background character-pool load (resolveWhitelistCharacters);
   * picks an initial character and renders once it resolves. Fire-and-forget. */
  loadPool(): void;
  /** The currently selected character's id, or null if none picked/available -
   * what the modal threads through into the returned SessionConfig. */
  currentCharacterId(): string | null;
}

/** Owns the character pool/selection/icon-cache for a new-chat modal's
 * right-side character pane and renders into `.me-char-pane` inside `overlay`. */
export function createCharacterPane(overlay: HTMLElement, projectId: string | null): CharacterPane {
  let character: Character | null = null;
  let pool: Character[] | null = null; // null = not loaded yet
  // icon url cache: charId -> url (null = in-flight)
  const iconCache = new Map<string, string | null>();

  /** Ids held by any live session (global dedup) - shared by the initial
   * random pick and the "Random" action inside the full character picker. */
  function liveTakenIds(): Set<string> {
    return new Set(
      state.sessions
        .filter((s) => !s.ended_at && !(s as { end_reason?: unknown }).end_reason)
        .map((s) => characterForSession(s))
        .filter((id): id is string => id !== null),
    );
  }

  /** Pick a random character from the pool, excluding `excludeId` and ids
   * already held by live sessions of this project. Falls back to the whole
   * pool (duplicate allowed) if the filtered set is empty. */
  function pickCharacter(excludeId: string | null): void {
    if (!pool || pool.length === 0) return;

    const liveTaken = liveTakenIds();

    // Prefer: pool minus liveTaken minus excludeId
    let candidates = pool.filter((c) => !liveTaken.has(c.id) && c.id !== excludeId);
    // Fallback: pool minus excludeId
    if (candidates.length === 0) candidates = pool.filter((c) => c.id !== excludeId);
    // Last resort: whole pool
    if (candidates.length === 0) candidates = pool;

    const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
    character = pick;
    playCharacterSelectSound(pick.id);
  }

  /** Render just the right-side character pane HTML; replaces .me-char-pane in place. */
  function renderCharPane(): void {
    const pane = overlay.querySelector<HTMLElement>(".me-char-pane");
    if (!pane) return;

    if (pool !== null && pool.length === 0) {
      pane.innerHTML = `<div class="me-char-empty">No characters available</div>`;
      return;
    }

    if (pool === null) {
      pane.innerHTML = `<div class="me-char-loading">Loading character...</div>`;
      return;
    }

    if (!character) {
      pane.innerHTML = `<div class="me-char-empty">No character selected</div>`;
      return;
    }

    const charId = character.id;
    const cachedUrl = iconCache.get(charId);
    // Portrait doubles as the "profile icon" entry point into the picker -
    // same role="button"/tabindex/title contract as the active-session
    // header's clickable avatar (session-header.ts).
    let portraitHtml: string;
    if (cachedUrl) {
      portraitHtml = `<img class="me-char-portrait me-char-clickable" src="${escapeHtml(cachedUrl)}" alt="${escapeHtml(character.label)}" data-char-portrait="${escapeHtml(charId)}" role="button" tabindex="0" title="Change character">`;
    } else {
      portraitHtml = `<div class="me-char-portrait me-char-portrait-ph me-char-clickable" data-char-portrait-ph="${escapeHtml(charId)}" role="button" tabindex="0" title="Change character"><i class="ph ph-question"></i></div>`;
    }

    const gameLine = character.game_label
      ? `<span class="me-char-game">${escapeHtml(character.game_label)}</span>`
      : "";

    pane.innerHTML = `
      ${portraitHtml}
      <span class="me-char-name">${escapeHtml(character.label)}</span>
      ${gameLine}
    `;

    attachCharHandlers();

    // Lazy-load portrait if not cached yet
    if (!iconCache.has(charId)) {
      iconCache.set(charId, null); // in-flight sentinel
      api.characterAssetUrl(charId, "icon.png").then((url) => {
        iconCache.set(charId, url);
        // Patch DOM directly - avoid full re-render
        const ph = overlay.querySelector<HTMLElement>(`[data-char-portrait-ph="${CSS.escape(charId)}"]`);
        if (ph && url) {
          const img = document.createElement("img");
          img.className = "me-char-portrait me-char-clickable";
          img.src = url;
          img.alt = character?.label ?? "";
          img.dataset.charPortrait = charId;
          img.setAttribute("role", "button");
          img.tabIndex = 0;
          img.title = "Change character";
          ph.replaceWith(img);
          wireClickable(img); // ph's own listener doesn't transfer across replaceWith
        }
      }).catch(() => { /* leave placeholder */ });
    }
  }

  /** Opens the full character picker directly from the portrait, excluding
   * ids already held by other live sessions so Random (inside the picker)
   * doesn't hand out a duplicate. */
  function openPickerFromPortrait(): void {
    if (!projectId) return;
    void openChangeCharacterModal({
      projectId,
      currentId: character?.id ?? null,
      excludeIds: [...liveTakenIds()],
    }).then(async (picked) => {
      if (!picked) return;
      // Look up in pool first; if not there (e.g. pool is "whitelisted" but user
      // picked from "all"), fetch the full list and find it there.
      let found = pool?.find((c) => c.id === picked) ?? null;
      if (!found) {
        try {
          const all = await api.listCharacters();
          found = all.find((c) => c.id === picked) ?? null;
        } catch {
          // best-effort; fall back to a stub
        }
      }
      // No sound here: the picker already played it when the pick was staged.
      // Stub fallback: only id is known; label/game unavailable but pane still works
      character = found ?? { id: picked, label: picked, version: 0, icon: "", slots: {} };
      renderCharPane();
    });
  }

  /** Wires click + Enter/Space-to-click onto one portrait node - never
   * delegated onto `.me-char-pane`, which (unlike the portrait) survives
   * partial re-renders, so a delegated listener there would stack. */
  function wireClickable(el: HTMLElement): void {
    el.addEventListener("click", () => openPickerFromPortrait());
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openPickerFromPortrait();
    });
  }

  function attachCharHandlers(): void {
    const portrait = overlay.querySelector<HTMLElement>(".me-char-clickable");
    if (portrait) wireClickable(portrait);
  }

  return {
    render: renderCharPane,
    loadPool(): void {
      // Cached (see new-session-cache.ts): a warm reopen picks + renders
      // immediately below; the background revalidation just keeps `pool`
      // fresh for the NEXT pick (re-roll / full picker) rather than
      // re-rolling the character already shown on this same open.
      const { cached, ready } = whitelistCharsData(projectId ?? "");
      if (cached !== undefined) {
        pool = cached;
        if (pool.length > 0) pickCharacter(null); // initial pick (plays sound)
        renderCharPane();
      }
      ready.then((chars) => {
        pool = chars;
        if (cached === undefined) {
          if (pool.length > 0) pickCharacter(null); // cold path: pick now
          renderCharPane();
        }
      }).catch(() => {
        if (cached === undefined) {
          pool = []; // treat as unavailable
          renderCharPane();
        }
      });
    },
    currentCharacterId(): string | null {
      return character?.id ?? null;
    },
  };
}
