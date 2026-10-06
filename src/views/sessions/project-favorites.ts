// Favourite project slots 1-9 for the Pick project modal, and the pure slot
// algebra behind them. Kept free of DOM and IPC so the assign/move/clear rules
// are unit-testable without rendering the picker (same split as
// account-picker-logic.ts).
//
// Desktop only, by Joe's call 2026-09-26: the keys are the whole point and a
// phone has no keyboard to press 1-9 with.

import type { ProjectGroup } from "../../types/ipc.generated";

/** A slot holds a project PATH, or null when empty. Always exactly
 *  SLOT_COUNT entries so slot N is always index N-1, with no shifting: the
 *  numbers are the feature, so an empty slot 3 must stay slot 3 rather than
 *  letting slot 4 slide into it. */
export type FavoriteSlots = (string | null)[];

export const SLOT_COUNT = 9;

export const FAVORITES_STORAGE_KEY = "claude_companion_project_favorites";

export function emptySlots(): FavoriteSlots {
  return new Array<string | null>(SLOT_COUNT).fill(null);
}

/** Coerces anything read back from storage into a well-formed slot array:
 *  right length, only strings or null, no duplicate path across two slots.
 *  A hand-edited or older-format value degrades to empty slots rather than
 *  throwing into the picker's render path. */
export function normalizeSlots(raw: unknown): FavoriteSlots {
  if (!Array.isArray(raw)) return emptySlots();
  const out = emptySlots();
  const seen = new Set<string>();
  for (let i = 0; i < SLOT_COUNT; i++) {
    const v = raw[i];
    if (typeof v !== "string" || v.length === 0) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out[i] = v;
  }
  return out;
}

export function readFavorites(): FavoriteSlots {
  try {
    const s = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!s) return emptySlots();
    return normalizeSlots(JSON.parse(s));
  } catch {
    // Malformed JSON, or localStorage throwing in private mode. Neither is
    // worth losing the picker over.
    return emptySlots();
  }
}

export function writeFavorites(slots: FavoriteSlots): void {
  try { localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(slots)); }
  catch { /* ignore */ }
}

function samePath(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

function inRange(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT;
}

/** Puts `path` in `slot`, replacing whatever was there. If `path` already
 *  sits in a DIFFERENT slot, that one is vacated - a project can never
 *  occupy two numbers, or "press 3" and "press 7" would mean the same
 *  thing. Returns a new array; never mutates. */
export function assignSlot(slots: FavoriteSlots, slot: number, path: string): FavoriteSlots {
  if (!inRange(slot) || !path) return slots.slice();
  const out = slots.slice();
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (i !== slot && samePath(out[i] ?? null, path)) out[i] = null;
  }
  out[slot] = path;
  return out;
}

/** Drag from one slot to another. Swaps when the target is occupied, moves
 *  when it is empty. Swap rather than overwrite on purpose: an overwrite
 *  silently deletes the project that was in the target, and the drag that
 *  produces it looks identical to a reorder. */
export function moveSlot(slots: FavoriteSlots, from: number, to: number): FavoriteSlots {
  if (!inRange(from) || !inRange(to) || from === to) return slots.slice();
  const out = slots.slice();
  const tmp = out[to] ?? null;
  out[to] = out[from] ?? null;
  out[from] = tmp;
  return out;
}

/** Drag a tile off the rail, or otherwise unfavourite one slot. */
export function clearSlot(slots: FavoriteSlots, slot: number): FavoriteSlots {
  if (!inRange(slot)) return slots.slice();
  const out = slots.slice();
  out[slot] = null;
  return out;
}

/** Slot index a path currently occupies, or -1. */
export function slotOf(slots: FavoriteSlots, path: string | null): number {
  if (!path) return -1;
  return slots.findIndex((p) => samePath(p ?? null, path));
}

/** Resolves a keypress to the path in that slot. `key` is the raw
 *  KeyboardEvent.key, so "1".."9"; anything else returns null. Slot 1 is
 *  key "1", not "0" - there is no slot 0 and "0" is deliberately inert. */
export function pathForKey(slots: FavoriteSlots, key: string): string | null {
  if (key.length !== 1 || key < "1" || key > "9") return null;
  return slots[Number(key) - 1] ?? null;
}

/** What a slot currently holds, shared by the composer's Ctrl+Shift strip
 *  and the picker's favourites rail (todo 1085) so an empty/resolved/gone
 *  slot renders the same decision in both places. `findProject` is each
 *  caller's own lookup (strip: the cached project list; rail: the picker's
 *  live map) - this stays free of both so it works against either. */
export type FavoriteSlotResolution =
  | { kind: "empty" }
  | { kind: "resolved"; project: ProjectGroup }
  | { kind: "unresolved"; path: string };

export function resolveFavoriteSlot(
  path: string | null,
  findProject: (path: string) => ProjectGroup | undefined,
): FavoriteSlotResolution {
  if (path === null) return { kind: "empty" };
  const project = findProject(path);
  return project ? { kind: "resolved", project } : { kind: "unresolved", path };
}
