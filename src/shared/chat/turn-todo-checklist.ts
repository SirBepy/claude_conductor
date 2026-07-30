/**
 * TodoWrite-driven step checklist (chat-tools.css .todo-checklist), split off
 * turn-chips.ts (ai_todo 411): a self-contained sub-concern that only reads
 * the `todoChecklist` field on a turn footer's state, invoked from
 * TurnFooterRegistry's settleMetaRow/cancelMetaRow and from
 * chat-event-handler.ts via the registry's delegating methods.
 */

import type { TurnFooterState } from "./turn-chips";

export type TodoStepStatus = "pending" | "active" | "done" | "skipped" | "interrupted";

interface TodoStepRow {
  row: HTMLElement;
  icon: HTMLElement;
  connectorFill: HTMLElement | null;
  status: TodoStepStatus;
}

export interface TodoChecklistState {
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

/** Set a row's icon + status class (and connector fill, when present). */
function applyTodoStepStatus(entry: TodoStepRow, status: TodoStepStatus): void {
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
export function ensureTodoChecklist(st: TurnFooterState | undefined): void {
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
export function updateTodoSteps(
  st: TurnFooterState | undefined,
  steps: { label: string; status: TodoStepStatus }[],
): void {
  if (!st || st.settled) return;
  if (!st.todoChecklist) ensureTodoChecklist(st);
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
    if (entry.status !== step.status) applyTodoStepStatus(entry, step.status);
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
export function interruptTodoChecklist(st: TurnFooterState | undefined): void {
  const tc = st?.todoChecklist;
  if (!tc) return;
  for (const entry of tc.rows.values()) {
    if (entry.status === "active") {
      applyTodoStepStatus(entry, "interrupted");
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
export function settleTodoChecklist(st: TurnFooterState | undefined): void {
  const tc = st?.todoChecklist;
  if (!tc || tc.settled) return;
  const total = tc.rows.size;
  for (const entry of tc.rows.values()) {
    if (entry.status === "pending" || entry.status === "active") {
      applyTodoStepStatus(entry, "skipped");
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
