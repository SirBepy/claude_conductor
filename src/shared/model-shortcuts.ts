// What each Alt+N model shortcut picks. The handler indexes readModels({}), a
// list the API fetch can reorder, shrink or extend, so every label that names
// a slot is derived from that same list instead of from shortcuts.ts's static
// defs.

import { readModels } from "./effort-presets";

export const MODEL_SHORTCUT_PREFIX = "set-model-";

/** 0-based slot of a `set-model-N` shortcut id, or null for any other id. */
export function modelShortcutSlot(id: string): number | null {
  if (!id.startsWith(MODEL_SHORTCUT_PREFIX)) return null;
  const n = Number(id.slice(MODEL_SHORTCUT_PREFIX.length));
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Model: Opus" for the family in `slot`, or null when the list has no such
 *  slot (the shortcut then does nothing, so it is not offered). */
export function modelShortcutLabel(slot: number, models: readonly string[] = readModels({})): string | null {
  const m = models[slot];
  return m === undefined ? null : `Model: ${cap(m)}`;
}

/** The Alt-held hint beside the header's model, e.g. "Alt 1-3". */
export function modelShortcutHint(models: readonly string[] = readModels({})): string {
  if (models.length === 0) return "";
  return models.length === 1 ? "Alt 1" : `Alt 1-${models.length}`;
}
