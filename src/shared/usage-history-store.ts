/**
 * IndexedDB home for the phone's saved usage history (see usage-history.ts).
 *
 * The page origin is per paired PC (the Android shell gives each its own
 * loopback origin), so one PC's rows can never be read as another's. localStorage
 * would hold the same data but caps near 5MB and blocks the main thread on
 * every read and write of a ~1MB blob.
 */

import type { StoredUsageHistory, UsageHistoryStore } from "./usage-history";

const DB_NAME = "cc-usage-history";
const STORE = "kv";
const KEY = "recent";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function isStored(v: unknown): v is StoredUsageHistory {
  const s = v as StoredUsageHistory | null;
  return !!s && Array.isArray(s.rows) && typeof s.floor === "number" && typeof s.cursor === "number";
}

export function indexedDbUsageHistoryStore(): UsageHistoryStore {
  const available = typeof indexedDB !== "undefined";
  return {
    async load() {
      if (!available) return null;
      try {
        const v = await withStore("readonly", (s) => s.get(KEY));
        return isStored(v) ? v : null;
      } catch {
        return null;
      }
    },
    async save(stored) {
      if (!available) return;
      try {
        await withStore("readwrite", (s) => s.put(stored, KEY));
      } catch {
        /* a full or blocked store only costs the next launch a download */
      }
    },
    async clear() {
      if (!available) return;
      try {
        await withStore("readwrite", (s) => s.delete(KEY));
      } catch {
        /* same */
      }
    },
  };
}
