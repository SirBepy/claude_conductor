/**
 * Cross-reload persistence for project icons (a base64 body per project over
 * `/api/rpc`), which projects.ts's memory cache loses on every page load. Each
 * entry keeps the hash the daemon stamped on the icon, so the next load asks
 * "still this one?" and gets a few bytes back instead of the body again.
 */

const CACHE_NAME = "project-icons-v1";

export interface PersistedProjectIcon {
  hash: string;
  url: string;
}

/** Synthetic same-origin key; never fetched, the Cache API just needs one. */
function keyFor(key: string): string {
  return `/__project-icon/${encodeURIComponent(key)}`;
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

/** The icon kept for `key` (`machineId|path`), or null when absent, unreadable or malformed. */
export async function readPersistedProjectIcon(key: string): Promise<PersistedProjectIcon | null> {
  const store = cacheStore();
  if (!store) return null;
  try {
    const cache = await store.open(CACHE_NAME);
    const hit = await cache.match(keyFor(key));
    if (!hit) return null;
    const parsed = JSON.parse(await hit.text()) as Partial<PersistedProjectIcon>;
    return typeof parsed.hash === "string" && typeof parsed.url === "string" && parsed.hash && parsed.url
      ? { hash: parsed.hash, url: parsed.url }
      : null;
  } catch {
    return null;
  }
}

/** Keep a resolved icon. Best-effort: a full quota just means the next load fetches it again. */
export async function persistProjectIcon(key: string, icon: PersistedProjectIcon): Promise<void> {
  const store = cacheStore();
  if (!store) return;
  try {
    const cache = await store.open(CACHE_NAME);
    await cache.put(keyFor(key), new Response(JSON.stringify(icon)));
  } catch {
    /* quota / unavailable - the memory cache still serves this session */
  }
}

/** Forget one project's kept icon, for when the daemon says the project has none any more. */
export async function dropPersistedProjectIcon(key: string): Promise<void> {
  const store = cacheStore();
  if (!store) return;
  try {
    const cache = await store.open(CACHE_NAME);
    await cache.delete(keyFor(key));
  } catch {
    /* nothing to drop */
  }
}
