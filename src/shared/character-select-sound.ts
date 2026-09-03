import { api } from "./api";

// Module-level timer so rapid picks (rerolling, clicking across the grid)
// replace each other instead of stacking overlapping voicelines.
let timer: ReturnType<typeof setTimeout> | null = null;

/** Plays a character's `select` voiceline, debounced by 250ms. Best-effort. */
export function playCharacterSelectSound(id: string): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    api.playCharacterSlot(id, "select").catch(() => {});
  }, 250);
}

/** Drops a pending play - call when the owning modal closes. */
export function cancelCharacterSelectSound(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
}
