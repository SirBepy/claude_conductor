/** The phone's last-known statusbar layout, kept in localStorage so a chat open
 *  draws its statusbar at once instead of waiting on a full `get_settings` over
 *  the tunnel (that read sat in front of the transcript request). Phone only:
 *  the desktop reads settings in-process. Holds chip names and one boolean,
 *  never a secret. The layout is refreshed behind every open, so an edit made
 *  on the PC shows from the next open on. */

import type { ChipType } from "./statusline-catalog";

const KEY = "cc_statusline_v1";

export interface CachedStatusline {
  rows: ChipType[][];
  hideZero: boolean;
}

export function loadCachedStatusline(): CachedStatusline | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<CachedStatusline>;
    if (!Array.isArray(p.rows) || typeof p.hideZero !== "boolean") return null;
    return { rows: p.rows, hideZero: p.hideZero };
  } catch {
    return null;
  }
}

export function saveCachedStatusline(v: CachedStatusline): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // Quota or private mode: the next open just reads settings first.
  }
}
