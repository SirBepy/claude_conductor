import {
  ensureTodoChecklist as ensureTodoChecklistImpl,
  updateTodoSteps as updateTodoStepsImpl,
  interruptTodoChecklist as interruptTodoChecklistImpl,
  settleTodoChecklist as settleTodoChecklistImpl,
  type TodoChecklistState,
  type TodoStepStatus,
} from "./turn-todo-checklist";
import { ensureMainStrip } from "./tool-strip";
import { absorbFooterContents } from "./tool-strip-merge";
import { META_KIND_ICONS, type MetaTurnKind } from "./chat-classifiers";
import {
  formatTurnDuration,
  formatTokenCount,
  estimateTokensFromText,
} from "./turn-footer-format";
import { renderStatusChip } from "./turn-status-chip";
import { renderWaitingChip, type WaitingOnTarget } from "./turn-waiting-chip";

export { formatTurnDuration, formatTokenCount, estimateTokensFromText };
export { applyWaitingOnNotification, onWaitingChipClick } from "./turn-waiting-chip";
export type { WaitingOnTarget } from "./turn-waiting-chip";

/**
 * Per-turn footer: a single block at the bottom of every response bundling
 *
 *   <div class="turn-footer" data-turn-id="K">
 *     <div class="turn-meta-chips">[tokens][time]</div>   <- row 1 (meta)
 *     <div class="tool-strip">...</div>                   <- row 2 (clickable chips)
 *     <div class="tool-strip-panel" hidden>...</div>      <- accordion
 *   </div>
 *
 * The meta row shows the turn's COMBINED output tokens (history replays one
 * usage event per assistant line - they are summed by the renderer before
 * freezing) and the time spent on the turn (live: ticks every 1s from the
 * user message's wall-clock time; frozen: real duration_ms, falling back to
 * the turn's timestamp span for history where duration_ms is absent).
 *
 * The renderer owns footer POSITION (kept at the container end while the
 * turn is active, pinned before the next user message when it closes); this
 * module owns footer CONTENT and the per-turn registry.
 */

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Unique-per-turn key (renderer-owned sequence number, NOT a timestamp). */
export type TurnChipKey = number;

/** Combined usage for one whole turn (summed across per-line usage events). */
export interface TurnUsageTotals {
  durationMs: number;
  outputTokens: number;
  inputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  costUsd: number;
  /** Last non-null `<cc-status:..>` marker seen across the turn's TurnUsage
   *  events ("question" | "working" | "waiting" | "done"), or undefined/null
   *  if no marker was ever parsed (pre-marker transcript, or a "done" line
   *  overwritten by nothing later). */
  awaiting?: string | null;
}

export interface TurnFooterState {
  footer: HTMLElement;
  metaRow: HTMLElement | null;
  timeChip: HTMLElement | null;
  timeTextNode: Text | null;
  tokenChip: HTMLElement | null;
  tokenTextNode: Text | null;
  /** Settle-only status chip (question/working/waiting/done). Never created
   *  for a live/ticking row - see settleMetaRow. */
  statusChip: HTMLElement | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  /** Wall-clock ms when the live turn started (for the ticking elapsed time). */
  turnStartMs: number;
  /** True once real usage totals landed. Stops the tick + the ~estimate, but
   * stays RE-SETTLEABLE: watched external sessions stream one usage event per
   * assistant line, and each must overwrite the totals with the bigger sum. */
  settled: boolean;
  /** Indeterminate/deterministic progress bar shown while the turn is active. */
  progressBar: HTMLElement | null;
  progressFill: HTMLElement | null;
  /** TodoWrite-driven step checklist (chat-tools.css .todo-checklist). Null
   *  until the turn's first TodoWrite call creates it. */
  todoChecklist: TodoChecklistState | null;
  /** Inline meta-turn chip (peer/fleet/retry/wake), static and non-clickable,
   *  living in the same .tool-strip row as the Ran/ToolSearch chips. Null
   *  until the turn's meta row (if any) is classified. */
  metaChip: HTMLElement | null;
  /** What a `waiting` turn is blocked on (todo 675) - a DIFFERENT concept
   *  from statusChip above (that's the done/question/waiting/working self-
   *  report; this names the actual thing being waited on). Null until a
   *  `waiting_on` notification lands for this turn. */
  waitingChip: HTMLElement | null;
  /** Totals the row last settled from, so a silent wake turn folding into
   *  this one (absorb) can add to them instead of overwriting. */
  lastTotals: TurnUsageTotals | null;
}

/** Build tooltip text for the settled token breakdown. */
function buildTooltip(totals: TurnUsageTotals): string {
  const parts: string[] = [
    `Input: ${totals.inputTokens.toLocaleString()} tok`,
    `Output: ${totals.outputTokens.toLocaleString()} tok`,
  ];
  if (totals.cacheCreate > 0) parts.push(`Cache write: ${totals.cacheCreate.toLocaleString()} tok`);
  if (totals.cacheRead > 0) parts.push(`Cache read: ${totals.cacheRead.toLocaleString()} tok`);
  if (totals.costUsd > 0) parts.push(`Cost: $${totals.costUsd.toFixed(4)}`);
  return parts.join(" | ");
}

/**
 * Per-renderer registry of turn footers. MUST be instance state, not module
 * state: chip keys are a per-renderer sequence (1, 2, 3...), so a shared map
 * would hand renderer B the footers of renderer A on key collisions, moving
 * old strips into the wrong chat pane.
 */
export class TurnFooterRegistry {
  private turns = new Map<TurnChipKey, TurnFooterState>();

  /**
   * Get (or create, detached) the footer element for a turn. The caller is
   * responsible for inserting it into the DOM at the right position.
   */
  getOrCreateFooter(key: TurnChipKey): HTMLElement {
    const existing = this.turns.get(key);
    if (existing) return existing.footer;
    const footer = document.createElement("div");
    footer.className = "turn-footer";
    footer.dataset.turnId = String(key);
    this.turns.set(key, {
      footer,
      metaRow: null,
      timeChip: null,
      timeTextNode: null,
      tokenChip: null,
      tokenTextNode: null,
      statusChip: null,
      tickTimer: null,
      turnStartMs: 0,
      settled: false,
      progressBar: null,
      progressFill: null,
      todoChecklist: null,
      metaChip: null,
      waitingChip: null,
      lastTotals: null,
    });
    return footer;
  }

  /** Totals this turn's meta row last settled from, or null if it never did. */
  getTotals(key: TurnChipKey): TurnUsageTotals | null {
    return this.turns.get(key)?.lastTotals ?? null;
  }

  /** Fold `srcKey`'s whole footer into `destKey`'s and forget it. Callers own
   *  the token/time arithmetic (getTotals + settleMetaRow). */
  absorbInto(srcKey: TurnChipKey, destKey: TurnChipKey): boolean {
    const src = this.turns.get(srcKey);
    const dest = this.turns.get(destKey);
    if (!src || !dest || src === dest) return false;
    if (src.tickTimer !== null) {
      clearInterval(src.tickTimer);
      src.tickTimer = null;
    }
    absorbFooterContents(src.footer, dest.footer);
    if (!dest.metaChip && src.metaChip) dest.metaChip = src.metaChip;
    if (!dest.todoChecklist && src.todoChecklist) dest.todoChecklist = src.todoChecklist;
    this.turns.delete(srcKey);
    return true;
  }

  /** Meta row (tokens + time) as the FIRST child of the footer. */
  private buildMetaRow(st: TurnFooterState): void {
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
   * from it, never from the key.
   */
  ensureLiveMetaRow(key: TurnChipKey, turnStartMs: number): void {
    const st = this.turns.get(key);
    if (!st || st.settled) return;
    if (st.metaRow) return;
    this.buildMetaRow(st);
    st.turnStartMs = turnStartMs;
    st.timeTextNode!.nodeValue = formatTurnDuration(Date.now() - turnStartMs);
    st.tickTimer = setInterval(() => {
      const cur = this.turns.get(key);
      if (!cur || cur.settled || !cur.timeTextNode) return;
      cur.timeTextNode.nodeValue = formatTurnDuration(Date.now() - cur.turnStartMs);
    }, 1000);
  }

  /** Primes a still-open turn after a reload with a live (non-settled) tick,
   *  seeded from the totals-so-far, so later events keep it ticking. */
  primeReplayedLiveRow(key: TurnChipKey, turnStartMs: number, totals: TurnUsageTotals): void {
    this.ensureLiveMetaRow(key, turnStartMs);
    const st = this.turns.get(key);
    if (!st || st.settled || !st.tokenTextNode) return;
    st.tokenTextNode.nodeValue = `${formatTokenCount(totals.outputTokens)} tok`;
    st.metaRow!.title = buildTooltip(totals);
  }

  /** Re-syncs the ticking row's elapsed text on every flush, since a
   *  minimized window can throttle setInterval. No-op once settled. */
  syncLiveTick(key: TurnChipKey): void {
    const st = this.turns.get(key);
    if (!st || st.settled || !st.timeTextNode || st.turnStartMs <= 0) return;
    st.timeTextNode.nodeValue = formatTurnDuration(Date.now() - st.turnStartMs);
  }

  /**
   * Update the live token estimate as assistant text streams in.
   * `text` is the full accumulated assistant text for this turn.
   */
  updateLiveTokenEstimate(key: TurnChipKey, text: string): void {
    const st = this.turns.get(key);
    if (!st || st.settled || !st.tokenTextNode) return;
    st.tokenTextNode.nodeValue = `~${formatTokenCount(estimateTokensFromText(text))} tok`;
  }

  /**
   * Settle the meta row to the turn's COMBINED totals. Creates the row if it
   * does not exist yet (history path). Stops the tick timer. Re-settleable:
   * each call overwrites the displayed totals with the latest (bigger) sums.
   * If durationMs is 0 the time chip is hidden rather than showing a lie.
   */
  settleMetaRow(key: TurnChipKey, totals: TurnUsageTotals): void {
    this.settleTodoChecklist(key);
    const st = this.turns.get(key);
    if (!st) return;
    this.buildMetaRow(st);
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

  /** Waiting-on chip (todo 675): what a `waiting` turn is blocked on. Creates
   *  the meta row too if the turn had none yet (a self-report can settle
   *  before any usage/status data exists). Re-callable: overwrites in place. */
  setWaitingOn(key: TurnChipKey, target: WaitingOnTarget): void {
    this.getOrCreateFooter(key);
    const st = this.turns.get(key)!;
    this.buildMetaRow(st);
    renderWaitingChip(st, target);
  }

  /**
   * Freeze a live meta row at its last elapsed/estimate values (turn was
   * interrupted or cancelled - no usage ever arrived). No-op when no meta row
   * exists or real totals already settled it.
   */
  cancelMetaRow(key: TurnChipKey): void {
    this.settleTodoChecklist(key);
    const st = this.turns.get(key);
    if (!st || st.settled || !st.metaRow) return;
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

  /**
   * Show an indeterminate progress bar at the top of the turn footer. Called
   * on the first tool_use of a turn so it only appears for multi-step work.
   * No-op if already created or if the turn has already settled.
   */
  ensureProgressBar(key: TurnChipKey): void {
    this.getOrCreateFooter(key);
    const st = this.turns.get(key);
    if (!st || st.settled || st.progressBar) return;
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
  setProgress(key: TurnChipKey, n: number, m: number): void {
    this.getOrCreateFooter(key);
    const st = this.turns.get(key);
    if (!st || st.settled) return;
    if (!st.progressBar) this.ensureProgressBar(key);
    if (!st.progressBar || !st.progressFill) return;
    const pct = m > 0 ? Math.min(100, Math.round((n / m) * 100)) : 0;
    st.progressFill.style.width = `${pct}%`;
    st.progressBar.classList.remove("turn-progress--indeterminate");
  }

  /** Calls getOrCreateFooter itself (not a bare `.get()`): chat-event-handler.ts
   *  mints this in the SAME event as the turn's chip key, before any flush
   *  creates footer state - skipping this made the first chip of every meta
   *  streak silently never render. Shares its strip via ensureMainStrip. */
  ensureMetaChip(key: TurnChipKey, meta: { kind: MetaTurnKind; label: string; detail: string; streakCount: number }): void {
    this.getOrCreateFooter(key);
    const st = this.turns.get(key)!;
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

  /** Create the TodoWrite-driven step checklist DOM. See turn-todo-checklist.ts. */
  ensureTodoChecklist(key: TurnChipKey): void {
    this.getOrCreateFooter(key);
    ensureTodoChecklistImpl(this.turns.get(key));
  }

  /** Re-render the checklist's steps. See turn-todo-checklist.ts. */
  updateTodoSteps(key: TurnChipKey, steps: { label: string; status: TodoStepStatus }[]): void {
    this.getOrCreateFooter(key);
    updateTodoStepsImpl(this.turns.get(key), steps);
  }

  /** Mark the active checklist row as interrupted. See turn-todo-checklist.ts. */
  interruptTodoChecklist(key: TurnChipKey): void {
    this.getOrCreateFooter(key);
    interruptTodoChecklistImpl(this.turns.get(key));
  }

  /** Settle the checklist into a collapsed summary chip. See turn-todo-checklist.ts. */
  settleTodoChecklist(key: TurnChipKey): void {
    this.getOrCreateFooter(key);
    settleTodoChecklistImpl(this.turns.get(key));
  }

  /** Remove every footer and clear all timers (renderer detach / bulk reset). */
  clear(): void {
    for (const st of this.turns.values()) {
      if (st.tickTimer !== null) clearInterval(st.tickTimer);
      st.footer.remove();
    }
    this.turns.clear();
  }
}
