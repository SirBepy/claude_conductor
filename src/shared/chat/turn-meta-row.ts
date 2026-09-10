/**
 * Meta-row (tokens + time) lifecycle for one turn footer: build, live-tick,
 * settle, cancel. Split off turn-chips.ts (todo 901) - it was the file's
 * single largest concern. Every export here takes the turn's own
 * `TurnFooterState` directly, the same free-function-over-state shape
 * turn-status-chip.ts and turn-waiting-chip.ts already established;
 * turn-chips.ts's registry methods stay thin key->state wrappers around them.
 */

import {
  formatTurnDuration,
  formatTokenCount,
  estimateTokensFromText,
} from "./turn-footer-format";
import { renderStatusChip } from "./turn-status-chip";
import type { TurnFooterState, TurnUsageTotals } from "./turn-chips";

/** Build tooltip text for the settled token breakdown. */
export function buildTooltip(totals: TurnUsageTotals): string {
  const parts: string[] = [
    `Input: ${totals.inputTokens.toLocaleString()} tok`,
    `Output: ${totals.outputTokens.toLocaleString()} tok`,
  ];
  if (totals.cacheCreate > 0) parts.push(`Cache write: ${totals.cacheCreate.toLocaleString()} tok`);
  if (totals.cacheRead > 0) parts.push(`Cache read: ${totals.cacheRead.toLocaleString()} tok`);
  if (totals.costUsd > 0) parts.push(`Cost: $${totals.costUsd.toFixed(4)}`);
  return parts.join(" | ");
}

/** Meta row (tokens + time) as the FIRST child of the footer. */
export function buildMetaRow(st: TurnFooterState): void {
  if (st.metaRow) return;
  const row = document.createElement("div");
  row.className = "turn-meta-chips";

  // Tokens first, time second (the user-specified order).
  const tokenChip = document.createElement("span");
  tokenChip.className = "turn-chip turn-chip--tokens";
  const tokenIcon = document.createElement("i");
  tokenIcon.className = "ph ph-arrow-up";
  const tokenTextNode = document.createTextNode("~0 tok");
  tokenChip.appendChild(tokenIcon);
  tokenChip.appendChild(tokenTextNode);

  const timeChip = document.createElement("span");
  timeChip.className = "turn-chip turn-chip--time";
  const timeIcon = document.createElement("i");
  timeIcon.className = "ph ph-timer";
  const timeTextNode = document.createTextNode("0s");
  timeChip.appendChild(timeIcon);
  timeChip.appendChild(timeTextNode);

  row.appendChild(tokenChip);
  row.appendChild(timeChip);
  st.footer.prepend(row);

  st.metaRow = row;
  st.tokenChip = tokenChip;
  st.tokenTextNode = tokenTextNode;
  st.timeChip = timeChip;
  st.timeTextNode = timeTextNode;
}

/**
 * Ensure a LIVE (ticking) meta row exists for the turn. `turnStartMs` must
 * be the wall-clock time the turn started - the elapsed display is computed
 * from it, never from the key. `getCurrent` re-fetches the state on every
 * tick (rather than closing over `st`) so a turn absorbed away mid-tick
 * stops updating instead of touching a detached row - registry callers pass
 * `() => this.turns.get(key)`, matching the original inline closure exactly.
 */
export function ensureLiveMetaRow(
  st: TurnFooterState,
  turnStartMs: number,
  getCurrent: () => TurnFooterState | undefined,
): void {
  if (st.settled) return;
  if (st.metaRow) return;
  buildMetaRow(st);
  st.turnStartMs = turnStartMs;
  st.timeTextNode!.nodeValue = formatTurnDuration(Date.now() - turnStartMs);
  st.tickTimer = setInterval(() => {
    const cur = getCurrent();
    if (!cur || cur.settled || !cur.timeTextNode) return;
    cur.timeTextNode.nodeValue = formatTurnDuration(Date.now() - cur.turnStartMs);
  }, 1000);
}

/** Primes a still-open turn after a reload with a live (non-settled) tick,
 *  seeded from the totals-so-far, so later events keep it ticking. */
export function primeReplayedLiveRow(
  st: TurnFooterState,
  turnStartMs: number,
  totals: TurnUsageTotals,
  getCurrent: () => TurnFooterState | undefined,
): void {
  ensureLiveMetaRow(st, turnStartMs, getCurrent);
  if (st.settled || !st.tokenTextNode) return;
  st.tokenTextNode.nodeValue = `${formatTokenCount(totals.outputTokens)} tok`;
  st.metaRow!.title = buildTooltip(totals);
}

/** Re-syncs the ticking row's elapsed text on every flush, since a
 *  minimized window can throttle setInterval. No-op once settled. */
export function syncLiveTick(st: TurnFooterState): void {
  if (st.settled || !st.timeTextNode || st.turnStartMs <= 0) return;
  st.timeTextNode.nodeValue = formatTurnDuration(Date.now() - st.turnStartMs);
}

/**
 * Update the live token estimate as assistant text streams in.
 * `text` is the full accumulated assistant text for this turn.
 */
export function updateLiveTokenEstimate(st: TurnFooterState, text: string): void {
  if (st.settled || !st.tokenTextNode) return;
  st.tokenTextNode.nodeValue = `~${formatTokenCount(estimateTokensFromText(text))} tok`;
}

/**
 * Settle the meta row to the turn's COMBINED totals. Creates the row if it
 * does not exist yet (history path). Stops the tick timer. Re-settleable:
 * each call overwrites the displayed totals with the latest (bigger) sums.
 * If durationMs is 0 the time chip is hidden rather than showing a lie.
 */
export function settleMetaRow(st: TurnFooterState, totals: TurnUsageTotals): void {
  buildMetaRow(st);
  st.settled = true;
  st.lastTotals = totals;
  if (st.tickTimer !== null) {
    clearInterval(st.tickTimer);
    st.tickTimer = null;
  }
  if (totals.durationMs > 0) {
    st.timeTextNode!.nodeValue = formatTurnDuration(totals.durationMs);
    st.timeChip!.classList.remove("turn-chip--hidden");
  } else {
    st.timeChip!.classList.add("turn-chip--hidden");
  }
  st.tokenTextNode!.nodeValue = `${formatTokenCount(totals.outputTokens)} tok`;
  st.metaRow!.title = buildTooltip(totals);
  renderStatusChip(st, totals.awaiting);
  if (st.progressBar) {
    st.progressBar.remove();
    st.progressBar = null;
    st.progressFill = null;
  }
}

/**
 * Freeze a live meta row at its last elapsed/estimate values (turn was
 * interrupted or cancelled - no usage ever arrived). No-op when no meta row
 * exists or real totals already settled it.
 */
export function cancelMetaRow(st: TurnFooterState): void {
  if (st.settled || !st.metaRow) return;
  st.settled = true;
  if (st.tickTimer !== null) {
    clearInterval(st.tickTimer);
    st.tickTimer = null;
  }
  if (st.turnStartMs > 0) {
    st.timeTextNode!.nodeValue = formatTurnDuration(Date.now() - st.turnStartMs);
  }
  if (st.progressBar) {
    st.progressBar.remove();
    st.progressBar = null;
    st.progressFill = null;
  }
}
