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
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format elapsed milliseconds as "14s", "1m 20s", "1h 5m". */
export function formatTurnDuration(ms: number): string {
  const totalSecs = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Compact token count: "980", "2.1k", "12.4k". Pass `{ decimals: 0 }` for the
 * decimal-free form used by the context chip, e.g. "90k" / "200k".
 */
export function formatTokenCount(n: number, opts?: { decimals?: number }): string {
  const decimals = opts?.decimals ?? 1;
  const v = Number(n) || 0;
  if (v >= 1_000) {
    const k = v / 1000;
    return `${decimals <= 0 ? Math.round(k) : k.toFixed(decimals)}k`;
  }
  return String(Math.round(v));
}

/** Estimate output tokens from streamed assistant text length (chars / 4). */
export function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.round(text.length / 4));
}

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
}

interface TurnFooterState {
  footer: HTMLElement;
  metaRow: HTMLElement | null;
  timeChip: HTMLElement | null;
  timeTextNode: Text | null;
  tokenChip: HTMLElement | null;
  tokenTextNode: Text | null;
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
}

export type TodoStepStatus = "pending" | "active" | "done" | "skipped" | "interrupted";

interface TodoStepRow {
  row: HTMLElement;
  icon: HTMLElement;
  connectorFill: HTMLElement | null;
  status: TodoStepStatus;
}

interface TodoChecklistState {
  el: HTMLElement;
  stepsEl: HTMLElement;
  /** True once settleTodoChecklist has run for this key - guards against a
   *  second settle call (settleMetaRow and cancelMetaRow both now invoke it
   *  as their first line). */
  settled: boolean;
  /** Rendered rows keyed by step label, so updateTodoSteps can diff against
   *  the previous call and patch in place instead of tearing the list down
   *  (which would restart every row's CSS animation, not just the changed one). */
  rows: Map<string, TodoStepRow>;
  /** Insertion order of step labels, mirroring `rows` - needed to remove rows
   *  no longer present without relying on Map iteration order guarantees. */
  order: string[];
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
      tickTimer: null,
      turnStartMs: 0,
      settled: false,
      progressBar: null,
      progressFill: null,
      todoChecklist: null,
    });
    return footer;
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
    const st = this.turns.get(key);
    if (!st || st.settled) return;
    if (!st.progressBar) this.ensureProgressBar(key);
    if (!st.progressBar || !st.progressFill) return;
    const pct = m > 0 ? Math.min(100, Math.round((n / m) * 100)) : 0;
    st.progressFill.style.width = `${pct}%`;
    st.progressBar.classList.remove("turn-progress--indeterminate");
  }

  /** Set a row's icon + status class (and connector fill, when present). */
  private applyTodoStepStatus(entry: TodoStepRow, status: TodoStepStatus): void {
    entry.status = status;
    entry.row.className = `todo-step todo-step--${status}`;
    let iconClass = "ph ph-circle";
    if (status === "active") iconClass = "ph ph-spinner-gap";
    else if (status === "done") iconClass = "ph-fill ph-check-circle";
    else if (status === "interrupted") iconClass = "ph ph-x-circle";
    entry.icon.innerHTML = `<i class="${iconClass}"></i>`;
    if (entry.connectorFill) {
      entry.connectorFill.style.height = status === "done" ? "100%" : "0%";
    }
  }

  /**
   * Create the TodoWrite-driven step checklist DOM (a container + an empty
   * steps list), inserted the same way ensureProgressBar inserts its bar.
   * No-op if already created or the turn has already settled.
   */
  ensureTodoChecklist(key: TurnChipKey): void {
    const st = this.turns.get(key);
    if (!st || st.settled || st.todoChecklist) return;
    const el = document.createElement("div");
    el.className = "todo-checklist";
    const stepsEl = document.createElement("ul");
    stepsEl.className = "todo-checklist-steps";
    el.appendChild(stepsEl);
    if (st.metaRow) {
      st.metaRow.insertAdjacentElement("afterend", el);
    } else {
      st.footer.prepend(el);
    }
    st.todoChecklist = { el, stepsEl, settled: false, rows: new Map(), order: [] };
  }

  /**
   * Re-render the checklist's steps. Creates the checklist if needed. Diffs
   * against what was rendered last time so existing rows update in place
   * (status class change) instead of the whole list being torn down and
   * rebuilt every call - which would restart the CSS animation on every row,
   * not just the one that actually changed.
   */
  updateTodoSteps(key: TurnChipKey, steps: { label: string; status: TodoStepStatus }[]): void {
    const st = this.turns.get(key);
    if (!st || st.settled) return;
    if (!st.todoChecklist) this.ensureTodoChecklist(key);
    const tc = st.todoChecklist;
    if (!tc) return;

    const seen = new Set<string>();
    for (const step of steps) {
      seen.add(step.label);
      let entry = tc.rows.get(step.label);
      if (!entry) {
        const row = document.createElement("li");
        const connector = document.createElement("span");
        connector.className = "todo-step-connector";
        const connectorFill = document.createElement("span");
        connectorFill.className = "todo-step-connector-fill";
        connector.appendChild(connectorFill);
        row.appendChild(connector);
        const icon = document.createElement("span");
        icon.className = "todo-step-icon";
        row.appendChild(icon);
        const label = document.createElement("span");
        label.className = "todo-step-label";
        label.textContent = step.label;
        row.appendChild(label);
        tc.stepsEl.appendChild(row);
        entry = { row, icon, connectorFill, status: "pending" };
        tc.rows.set(step.label, entry);
        tc.order.push(step.label);
      }
      if (entry.status !== step.status) this.applyTodoStepStatus(entry, step.status);
    }
    // Remove rows for steps no longer present (rare, but don't crash if it happens).
    for (const label of tc.order) {
      if (seen.has(label)) continue;
      tc.rows.get(label)?.row.remove();
      tc.rows.delete(label);
    }
    tc.order = tc.order.filter((label) => seen.has(label));
  }

  /**
   * Mark whichever row is currently `active` as `interrupted` (the turn was
   * cancelled mid-step). No-op if no checklist or no active row.
   */
  interruptTodoChecklist(key: TurnChipKey): void {
    const tc = this.turns.get(key)?.todoChecklist;
    if (!tc) return;
    for (const entry of tc.rows.values()) {
      if (entry.status === "active") {
        this.applyTodoStepStatus(entry, "interrupted");
        break;
      }
    }
  }

  /**
   * Settle the checklist: sweep any leftover pending/active row to `skipped`
   * (a race - never interrupted or completed), then collapse the visible
   * rows into a single summary chip. Self-guards against a second call for
   * the same key, since settleMetaRow and cancelMetaRow both now invoke this
   * as their first line.
   */
  settleTodoChecklist(key: TurnChipKey): void {
    const tc = this.turns.get(key)?.todoChecklist;
    if (!tc || tc.settled) return;
    const total = tc.rows.size;
    for (const entry of tc.rows.values()) {
      if (entry.status === "pending" || entry.status === "active") {
        this.applyTodoStepStatus(entry, "skipped");
      }
    }
    tc.settled = true;
    const chip = document.createElement("span");
    chip.className = "turn-chip";
    const icon = document.createElement("i");
    icon.className = "ph-fill ph-check-circle";
    chip.appendChild(icon);
    chip.appendChild(document.createTextNode(` ${total} step${total === 1 ? "" : "s"}`));
    tc.el.classList.add("todo-checklist-collapsed");
    tc.el.replaceChildren(chip);
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
