// Where an Alt+1-4 (model) or Alt+Up/Down (effort) press lands. Pure, so the
// rules are unit-testable; ModelEffortState commits the result and
// config-bump.ts animates it.

import { EFFORTS, modelFamilyFromId } from "../../shared/effort-presets";
import type { BumpDirection } from "./config-bump";

export interface KeyTarget {
  /** Null when the press changes nothing (same model, or past the last effort). */
  next: string | null;
  dir: BumpDirection;
}

/** `slot` is 0-based. Models are ordered smallest to biggest, so a higher slot
 *  reads as "up". A slot past the list is no target at all. */
export function modelKeyTarget(models: readonly string[], current: string | null, slot: number): KeyTarget | null {
  const next = models[slot];
  if (next === undefined) return null;
  const at = current ? models.indexOf(modelFamilyFromId(current)) : -1;
  if (at === slot) return { next: null, dir: 0 };
  return { next, dir: at === -1 || slot > at ? 1 : -1 };
}

/** One step along EFFORTS; an unknown current value starts from "high". */
export function effortStepTarget(current: string, step: 1 | -1): KeyTarget {
  const at = EFFORTS.indexOf(current as typeof EFFORTS[number]);
  const from = at === -1 ? EFFORTS.indexOf("high") : at;
  const next = EFFORTS[from + step];
  if (next === undefined) return { next: null, dir: 0 };
  return { next, dir: step };
}
