/**
 * Indeterminate/deterministic progress bar shown while a turn is active.
 * Split off turn-chips.ts (todo 901); free functions over `TurnFooterState`,
 * the same shape turn-meta-row.ts and turn-status-chip.ts already use.
 */

import type { TurnFooterState } from "./turn-chips";

/**
 * Show an indeterminate progress bar at the top of the turn footer. Called
 * on the first tool_use of a turn so it only appears for multi-step work.
 * No-op if already created or if the turn has already settled.
 */
export function ensureProgressBar(st: TurnFooterState): void {
  if (st.settled || st.progressBar) return;
  const bar = document.createElement("div");
  bar.className = "turn-progress turn-progress--indeterminate";
  const fill = document.createElement("div");
  fill.className = "turn-progress-fill";
  bar.appendChild(fill);
  if (st.metaRow) {
    st.metaRow.insertAdjacentElement("afterend", bar);
  } else {
    st.footer.prepend(bar);
  }
  st.progressBar = bar;
  st.progressFill = fill;
}

/**
 * Update the progress bar to a deterministic N/M state. Creates the bar if
 * it doesn't exist. No-op when the turn has already settled.
 */
export function setProgress(st: TurnFooterState, n: number, m: number): void {
  if (st.settled) return;
  if (!st.progressBar) ensureProgressBar(st);
  if (!st.progressBar || !st.progressFill) return;
  const pct = m > 0 ? Math.min(100, Math.round((n / m) * 100)) : 0;
  st.progressFill.style.width = `${pct}%`;
  st.progressBar.classList.remove("turn-progress--indeterminate");
}
