/**
 * Character UI helpers. Authoritative list lives in Rust; fetched lazily and cached.
 * Replaces the deprecated shared/sound-packs.ts.
 */

import { api, type Character, type CharacterSlot } from "./api";
import { clearPersistedIcons } from "./character-icon-store";
import { clearCharacterIconCache } from "./character-icon";

let cache: Character[] | null = null;

export async function loadCharacters(): Promise<Character[]> {
  if (cache) return cache;
  try {
    cache = await api.listCharacters();
  } catch (e) {
    console.error("[characters] list failed", e);
    cache = [];
  }
  return cache;
}

/** Drop every client-side character cache: the list above, the shared icon
 *  memory cache, and the cross-reload icon store. Local only - a remote client
 *  reacting to the daemon's `characters-changed` wants exactly this half, with
 *  no backend round trip (the backend is where the event came from). */
export function resetCharacterCaches(): void {
  cache = null;
  // Icon data URLs persist across reloads (character-icon-store.ts) and in
  // memory (character-icon.ts), so a character whose artwork was replaced on
  // disk would keep serving the old image forever without both of these.
  clearCharacterIconCache();
  void clearPersistedIcons();
}

export function invalidateCharactersCache(): void {
  resetCharacterCaches();
  // Fire-and-forget: also drop the Rust-side cache so the next list reads
  // fresh from disk. Backend errors are non-fatal here; the frontend cache
  // is already cleared and the next `loadCharacters()` will surface any
  // real failure.
  api.invalidateCharactersCache().catch((e) => {
    console.error("[characters] backend invalidate failed", e);
  });
}

export function findCharacter(chars: Character[], id: string): Character | null {
  return chars.find((c) => c.id === id) || null;
}

export function slotFillCount(c: Character): { filled: number; total: number } {
  const all: CharacterSlot[] = ["work_finished", "question_asked", "ready", "select", "annoyed", "death"];
  const filled = all.filter((s) => (c.slots[s]?.length ?? 0) > 0).length;
  return { filled, total: all.length };
}

export function populateCharacterSelect(
  selectEl: HTMLSelectElement,
  chars: Character[],
  currentId: string | null,
): void {
  const noneSel = currentId === null ? " selected" : "";
  const opts = chars.map((c) => {
    const sel = c.id === currentId ? " selected" : "";
    return `<option value="${c.id}"${sel}>${c.label}</option>`;
  }).join("");
  selectEl.innerHTML = `<option value=""${noneSel}>(none — global default)</option>${opts}`;
}
