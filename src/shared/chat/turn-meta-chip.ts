/**
 * Inline meta-turn chip (peer/fleet/retry/wake): static and non-clickable,
 * living in the same `.tool-strip` row as the Ran/ToolSearch chips. Split
 * off turn-chips.ts (todo 901); free function over `TurnFooterState`, the
 * same shape turn-meta-row.ts and turn-status-chip.ts already use.
 */

import { ensureMainStrip } from "./tool-strip";
import { META_KIND_ICONS, type MetaTurnKind } from "./chat-classifiers";
import type { TurnFooterState } from "./turn-chips";

/** Re-callable: overwrites the chip in place, or (re)creates it if the strip
 *  was rebuilt since. Shares its strip via ensureMainStrip. */
export function ensureMetaChip(
  st: TurnFooterState,
  meta: { kind: MetaTurnKind; label: string; detail: string; streakCount: number },
): void {
  const { strip } = ensureMainStrip(st.footer);
  let chip = st.metaChip;
  if (!chip || chip.parentElement !== strip) {
    chip = document.createElement("span");
    chip.appendChild(document.createElement("i"));
    const label = document.createElement("span");
    label.className = "tool-chip-label";
    chip.appendChild(label);
    const count = document.createElement("span");
    count.className = "tool-chip-count";
    chip.appendChild(count);
    strip.prepend(chip);
    st.metaChip = chip;
  }
  chip.className = `tool-chip tool-chip--meta tool-chip--meta-${meta.kind}`;
  chip.title = meta.detail;
  (chip.children[0] as HTMLElement).className = `ph ${META_KIND_ICONS[meta.kind]}`;
  (chip.children[1] as HTMLElement).textContent = meta.label;
  (chip.children[2] as HTMLElement).textContent = meta.streakCount > 1 ? `×${meta.streakCount}` : "";
}
