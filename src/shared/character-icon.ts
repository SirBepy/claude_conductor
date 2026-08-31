/**
 * Shared character-icon resolution + hydration (ai_todo 101).
 *
 * One module-level `charId -> icon data URL` cache for every surface that shows
 * character icons (the change-character modal grid, the whitelist editor rows,
 * and the sessions sidebar faces). Previously each kept its own cache + async
 * patch loop; this collapses them to a single source.
 *
 * `null` in the cache means "resolved, but the character has no icon" - distinct
 * from "not yet resolved" (key absent). An in-flight map de-dupes concurrent
 * requests for the same id so repeated re-renders never re-fetch.
 */

import { api } from "./api";
import { persistIcon, readPersistedIcon } from "./character-icon-store";

const iconUrlCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Resolve (and cache) a character's `icon.png` data URL. Returns null when the
 *  character has no icon or the lookup fails. Cached + de-duped, so calling it
 *  repeatedly only ever fetches each id once. Checks the cross-reload store
 *  first; a "no icon" result stays memory-only so later artwork is picked up. */
export async function getCharacterIconUrl(id: string): Promise<string | null> {
  const cached = iconUrlCache.get(id);
  if (cached !== undefined) return cached;
  const existing = inflight.get(id);
  if (existing) return existing;

  const p = (async () => {
    let url = await readPersistedIcon(id);
    if (!url) {
      try {
        url = (await api.characterAssetUrl(id, "icon.png")) ?? null;
      } catch {
        url = null;
      }
      if (url) void persistIcon(id, url);
    }
    iconUrlCache.set(id, url);
    inflight.delete(id);
    return url;
  })();
  inflight.set(id, p);
  return p;
}

/** Synchronous read of an already-resolved icon URL. Returns null both when the
 *  id hasn't been resolved yet and when it resolved to no icon. */
export function cachedCharacterIconUrl(id: string): string | null {
  return iconUrlCache.get(id) ?? null;
}

/** Fill every `img[data-char-id]` under `host` whose icon resolves. Idempotent;
 *  leaves imgs whose character has no icon untouched. */
export async function hydrateCharacterIcons(host: HTMLElement): Promise<void> {
  const imgs = host.querySelectorAll<HTMLImageElement>("img[data-char-id]");
  await Promise.all(
    [...imgs].map(async (img) => {
      const id = img.dataset.charId;
      if (!id) return;
      const url = await getCharacterIconUrl(id);
      if (url && img.isConnected) img.src = url;
    }),
  );
}
