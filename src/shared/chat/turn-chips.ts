import {
  ensureTodoChecklist as ensureTodoChecklistImpl,
  updateTodoSteps as updateTodoStepsImpl,
  interruptTodoChecklist as interruptTodoChecklistImpl,
  settleTodoChecklist as settleTodoChecklistImpl,
  type TodoChecklistState,
  type TodoStepStatus,
} from "./turn-todo-checklist";
import { absorbFooterContents } from "./tool-strip-merge";
import { type MetaTurnKind } from "./chat-classifiers";
import { formatTurnDuration, formatTokenCount, estimateTokensFromText } from "./turn-footer-format";
import {
  buildMetaRow,
  ensureLiveMetaRow as ensureLiveMetaRowImpl,
  primeReplayedLiveRow as primeReplayedLiveRowImpl,
  syncLiveTick as syncLiveTickImpl,
  updateLiveTokenEstimate as updateLiveTokenEstimateImpl,
  settleMetaRow as settleMetaRowImpl,
  cancelMetaRow as cancelMetaRowImpl,
} from "./turn-meta-row";
import { ensureProgressBar as ensureProgressBarImpl, setProgress as setProgressImpl } from "./turn-progress-bar";
import { ensureMetaChip as ensureMetaChipImpl } from "./turn-meta-chip";
import { renderWaitingChip, type WaitingOnTarget } from "./turn-waiting-chip";
import {
  addAgentDot as addAgentDotImpl,
  updateAgentDotActivity as updateAgentDotActivityImpl,
  finishAgentDot as finishAgentDotImpl,
  settleAgentRail as settleAgentRailImpl,
  type AgentRailState,
} from "./turn-agent-rail";

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
  /** Live-subagent avatar row (todo 899). Null until the turn's first
   *  Task/Agent tool_use creates it. */
  agentRail: AgentRailState | null;
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
      agentRail: null,
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
    if (!dest.agentRail && src.agentRail) dest.agentRail = src.agentRail;
    this.turns.delete(srcKey);
    return true;
  }

  /** Ensure a LIVE (ticking) meta row exists for the turn. See turn-meta-row.ts. */
  ensureLiveMetaRow(key: TurnChipKey, turnStartMs: number): void {
    const st = this.turns.get(key);
    if (!st) return;
    ensureLiveMetaRowImpl(st, turnStartMs, () => this.turns.get(key));
  }

  /** Primes a still-open turn after a reload with a live (non-settled) tick.
   *  See turn-meta-row.ts. */
  primeReplayedLiveRow(key: TurnChipKey, turnStartMs: number, totals: TurnUsageTotals): void {
    const st = this.turns.get(key);
    if (!st) return;
    primeReplayedLiveRowImpl(st, turnStartMs, totals, () => this.turns.get(key));
  }

  /** Re-syncs the ticking row's elapsed text on every flush. See turn-meta-row.ts. */
  syncLiveTick(key: TurnChipKey): void {
    const st = this.turns.get(key);
    if (!st) return;
    syncLiveTickImpl(st);
  }

  /** Update the live token estimate as assistant text streams in. See turn-meta-row.ts. */
  updateLiveTokenEstimate(key: TurnChipKey, text: string): void {
    const st = this.turns.get(key);
    if (!st) return;
    updateLiveTokenEstimateImpl(st, text);
  }

  /** Settle the meta row to the turn's COMBINED totals. See turn-meta-row.ts. */
  settleMetaRow(key: TurnChipKey, totals: TurnUsageTotals): void {
    this.settleTodoChecklist(key);
    const st = this.turns.get(key);
    if (!st) return;
    settleAgentRailImpl(st);
    settleMetaRowImpl(st, totals);
  }

  /** Waiting-on chip (todo 675): what a `waiting` turn is blocked on. Creates
   *  the meta row too if the turn had none yet (a self-report can settle
   *  before any usage/status data exists). Re-callable: overwrites in place. */
  setWaitingOn(key: TurnChipKey, target: WaitingOnTarget): void {
    this.getOrCreateFooter(key);
    const st = this.turns.get(key)!;
    buildMetaRow(st);
    renderWaitingChip(st, target);
  }

  /** Freeze a live meta row at its last elapsed/estimate values. See turn-meta-row.ts. */
  cancelMetaRow(key: TurnChipKey): void {
    this.settleTodoChecklist(key);
    const st = this.turns.get(key);
    if (!st) return;
    settleAgentRailImpl(st);
    cancelMetaRowImpl(st);
  }

  /** Show an indeterminate progress bar at the top of the turn footer. See
   *  turn-progress-bar.ts. */
  ensureProgressBar(key: TurnChipKey): void {
    this.getOrCreateFooter(key);
    const st = this.turns.get(key);
    if (!st) return;
    ensureProgressBarImpl(st);
  }

  /** Update the progress bar to a deterministic N/M state. See
   *  turn-progress-bar.ts. */
  setProgress(key: TurnChipKey, n: number, m: number): void {
    this.getOrCreateFooter(key);
    const st = this.turns.get(key);
    if (!st) return;
    setProgressImpl(st, n, m);
  }

  /** Calls getOrCreateFooter itself (not a bare `.get()`): chat-event-handler.ts
   *  mints this in the SAME event as the turn's chip key, before any flush
   *  creates footer state - skipping this made the first chip of every meta
   *  streak silently never render. See turn-meta-chip.ts. */
  ensureMetaChip(key: TurnChipKey, meta: { kind: MetaTurnKind; label: string; detail: string; streakCount: number }): void {
    this.getOrCreateFooter(key);
    const st = this.turns.get(key)!;
    ensureMetaChipImpl(st, meta);
  }

  /** Whether this turn already owns a step checklist, whichever tool drove it.
   *  Tool-agnostic on purpose: `turnTodosBaseline` is TodoWrite's diffing
   *  state, and `write_plan` has no baseline semantics at all (todo 902).
   *  Never creates a footer - a bare read must not mint a turn. */
  hasTodoChecklist(key: TurnChipKey): boolean {
    return this.turns.get(key)?.todoChecklist != null;
  }

  /** Create the TodoWrite-driven step checklist DOM. See turn-todo-checklist.ts. */
  ensureTodoChecklist(key: TurnChipKey): void {
    this.getOrCreateFooter(key);
    ensureTodoChecklistImpl(this.turns.get(key));
  }

  /** Re-render the checklist's steps. See turn-todo-checklist.ts. */
  updateTodoSteps(
    key: TurnChipKey,
    steps: { label: string; status: TodoStepStatus; detail?: string }[],
  ): void {
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

  /** Add a live agent-rail dot for a newly-spawned top-level Task/Agent call.
   *  See turn-agent-rail.ts. */
  addAgentDot(key: TurnChipKey, id: string, label: string, spawnedDuring: string | null): void {
    this.getOrCreateFooter(key);
    addAgentDotImpl(this.turns.get(key)!, id, label, spawnedDuring);
  }

  /** Update a live dot's current-activity line from a routed child tool_use.
   *  See turn-agent-rail.ts. */
  updateAgentDotActivity(key: TurnChipKey, parentId: string, activity: string): void {
    const st = this.turns.get(key);
    if (!st) return;
    updateAgentDotActivityImpl(st, parentId, activity);
  }

  /** Play the death animation and fold a finished dot into the ghost pill.
   *  See turn-agent-rail.ts. */
  finishAgentDot(key: TurnChipKey, id: string): void {
    const st = this.turns.get(key);
    if (!st) return;
    finishAgentDotImpl(st, id);
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
