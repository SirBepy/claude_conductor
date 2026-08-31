/**
 * Cross-reload persistence for character-icon data URLs (~34KB each over
 * `/api/rpc`), which character-icon.ts's memory cache loses on every load.
 */

const CACHE_NAME = "character-icons-v1";

/** Synthetic same-origin key; never fetched, the Cache API just needs one. */
function keyFor(id: string): string {
  return `/__character-icon/${encodeURIComponent(id)}`;
}

/** Cache API, not localStorage: async reads and a far larger quota. Null where
 *  it is absent (jsdom, insecure origins), which makes every caller a no-op. */
function cacheStore(): CacheStorage | null {
  try {
    return typeof caches !== "undefined" ? caches : null;
  } catch {
    return null;
  }
}

/** Previously-persisted data URL for `id`, or null if absent/unavailable. */
export async function readPersistedIcon(id: string): Promise<string | null> {
  const store = cacheStore();
  if (!store) return null;
  try {
    const cache = await store.open(CACHE_NAME);
    const hit = await cache.match(keyFor(id));
    if (!hit) return null;
    const text = await hit.text();
    return text || null;
  } catch {
    return null;
  }
}

/** Persist a resolved data URL. Best-effort: a full quota just means the next
 *  load refetches, never a broken icon. */
export async function persistIcon(id: string, dataUrl: string): Promise<void> {
  const store = cacheStore();
  if (!store) return;
  try {
    const cache = await store.open(CACHE_NAME);
    await cache.put(keyFor(id), new Response(dataUrl));
  } catch {
    /* quota / unavailable - the memory cache still serves this session */
  }
}

/** Drops every persisted icon, for when a character's artwork is replaced. */
export async function clearPersistedIcons(): Promise<void> {
  const store = cacheStore();
  if (!store) return;
  try {
    await store.delete(CACHE_NAME);
  } catch {
    /* nothing to drop */
  }
}
