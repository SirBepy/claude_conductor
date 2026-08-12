/**
 * Per-SESSION Heroes of the Storm character lookup for the sessions sidebar.
 *
 * The backend assigns every live session an `Avatar::Character(id)` via
 * `ensure_session_character`. This module caches a `session_id -> char_id` map
 * so `renderSidebar` can resolve a session's hero; the `char_id -> icon URL`
 * cache + resolution lives in the shared `character-icon` module so this surface
 * can emit a filled `<img src>` synchronously without flashing broken images.
 *
 * Populated on mount and refreshed on the `settings-changed` event (which fires
 * whenever a character is assigned or re-rolled).
 */

import { api } from "../../shared/api";
import { getCharacterIconUrl, cachedCharacterIconUrl } from "../../shared/character-icon";
import type { Instance } from "../../types/ipc.generated";

/** session_id -> char_id */
let sessionCharMap = new Map<string, string>();

/** (Re)load the session -> character map and preload each hero's icon data URL.
 * Safe to call repeatedly; the shared icon cache reuses already-fetched URLs. */
export async function loadSessionCharacters(): Promise<void> {
  try {
    const raw = await api.listSessionCharacters();
    const bySession = new Map<string, string>();
    for (const [sid, cid] of Object.entries(raw)) {
      if (cid) bySession.set(sid, cid);
    }
    sessionCharMap = bySession;

    // Preload icon data URLs so rows render with `src` already set. The shared
    // cache de-dupes, so a refresh only fetches genuinely-new heroes.
    const ids = new Set<string>(bySession.values());
    await Promise.all([...ids].map((id) => getCharacterIconUrl(id)));
  } catch (e) {
    console.warn("[sessions] loadSessionCharacters failed", e);
  }
}

/** The assigned HotS character id for a session, or null if not yet assigned
 * (or the map isn't loaded yet). */
export function characterForSession(s: Instance): string | null {
  return characterForSessionId(s.session_id);
}

/** Same lookup keyed directly by session id, for callers (History view) that
 * only have a HistoryEntry, not a live Instance. */
export function characterForSessionId(sessionId: string): string | null {
  return sessionCharMap.get(sessionId) ?? null;
}

/** Sync write into the cache, ahead of the async `settings-changed`
 * round-trip, so a freshly-rendered header doesn't flash the placeholder. */
export function setSessionCharacterLocal(sessionId: string, charId: string): void {
  sessionCharMap.set(sessionId, charId);
}

/** Preloaded icon data URL for a character id, or null if not yet cached. */
export function characterIconUrl(charId: string): string | null {
  return cachedCharacterIconUrl(charId);
}
