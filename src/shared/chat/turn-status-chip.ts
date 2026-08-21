/** Settle-only status chip for a turn's folded `<cc-status:..>` marker (todo
 *  729). Owns STATUS_CHIP_META; the waiting-on chip is a separate concept in
 *  turn-waiting-chip.ts. */

import { STATUS_ICON } from "../status-icons";
import type { TurnFooterState } from "./turn-chips";

/** Title for each `<cc-status:..>` value; icons come from the shared
 *  STATUS_ICON table. "done" is deliberately left uncolored (no
 *  `turn-chip--status-*` modifier) - a settled turn is the calm default,
 *  not something to highlight. */
const STATUS_CHIP_META: Record<string, { icon: string; title: string }> = {
  question: { icon: STATUS_ICON.question, title: "Ended with a question" },
  working: { icon: STATUS_ICON.working, title: "Working in the background" },
  waiting: { icon: STATUS_ICON.waiting, title: "Waiting on an external process" },
  done: { icon: STATUS_ICON.done, title: "Turn completed" },
};

/** Never called from the live/ticking path (ensureLiveMetaRow) - a status only
 *  means something once the turn is done, so it must not flash mid-turn. No
 *  chip at all when no marker was ever parsed (undefined/null/unknown). */
export function renderStatusChip(st: TurnFooterState, awaiting: string | null | undefined): void {
  const meta = awaiting ? STATUS_CHIP_META[awaiting] : undefined;
  if (!meta) {
    st.statusChip?.remove();
    st.statusChip = null;
    return;
  }
  if (!st.statusChip) {
    const chip = document.createElement("span");
    chip.className = "turn-chip turn-chip--status";
    chip.appendChild(document.createElement("i"));
    st.metaRow!.appendChild(chip);
    st.statusChip = chip;
  }
  st.statusChip.title = meta.title;
  st.statusChip.className = `turn-chip turn-chip--status turn-chip--status-${awaiting}`;
  st.statusChip.firstElementChild!.className = `ph ${meta.icon}`;
}
