/** The phone's last-known chats list, kept in localStorage so a reopened app
 *  paints the list before the tunnel answers `list_instances` (its signal
 *  drops often). Phone only: the desktop's local pipe answers in
 *  milliseconds, and its list never needs to outlive a reload. Rows carry
 *  names, paths and status, never a secret. */

import type { Instance } from "../../types/ipc.generated";

const KEY = "cc_instances_v1";

export function loadCachedInstances(): Instance[] | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Instance[]) : null;
  } catch {
    return null;
  }
}

export function saveCachedInstances(list: Instance[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Quota or private mode: the next boot just waits for the network.
  }
}
