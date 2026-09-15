/**
 * TodoWrite-driven step checklist (chat-tools.css .todo-checklist), split off
 * turn-chips.ts (ai_todo 411): a self-contained sub-concern that only reads
 * the `todoChecklist` field on a turn footer's state, invoked from
 * TurnFooterRegistry's settleMetaRow/cancelMetaRow and from
 * chat-event-handler.ts via the registry's delegating methods.
 *
 * Step comments (todo 898): Joe can leave a note on a still-`pending` row of
 * a `write_plan`-sourced checklist; the daemon holds it and hands it back to
 * the session the moment that step goes `active` (see
 * `daemon/hooks_server/plan.rs`). TodoWrite-driven checklists never get the
 * affordance - that tool's `tool_result` is Claude's builtin, never routed
 * through our daemon, so there is no response to carry a comment back in.
 * `commentable`/`sessionId` are read once, at checklist creation, off
 * `data-plan-*` attributes chat-event-handler-tools.ts stamps on the turn
 * footer element (the only file allowed to touch `TurnFooterState` itself -
 * see this repo's turn-chips.ts off-limits note).
 */

import type { TurnFooterState } from "./turn-chips";
import { addStepComment } from "./step-comment-sync";

export type TodoStepStatus = "pending" | "active" | "done" | "skipped" | "interrupted";

/** One row's comment affordance/editor/noted-indicator (todo 898). */
interface TodoStepCommentState {
  /** The trailing icon element in the row: the "leave a note" affordance
   *  before any comment is submitted, or the persisted "noted" indicator
   *  after. Same element, restyled in place - see submitStepComment. */
  el: HTMLElement;
  /** Present only while the inline editor is open. */
  editor: HTMLElement | null;
  textarea: HTMLTextAreaElement | null;
  /** Last submitted comment text, or null before any submit. A non-null
   *  value is also the signal that keeps this affordance alive once the step
   *  leaves `pending` - see applyTodoStepStatus. */
  text: string | null;
}

interface TodoStepRow {
  row: HTMLElement;
  icon: HTMLElement;
  connectorFill: HTMLElement | null;
  status: TodoStepStatus;
  /** The step's own one-line description, revealed on click. Only `write_plan`
   *  supplies one; TodoWrite's `activeForm` is read for the thinking bar and
   *  never reaches a row, so a TodoWrite-driven checklist has no detail at all. */
  detailEl: HTMLElement | null;
  /** Null on a TodoWrite-driven checklist, or once a never-commented step
   *  leaves `pending` (todo 898 - the affordance is removed outright rather
   *  than left as a dead button promising something it can no longer do). */
  comment: TodoStepCommentState | null;
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
  /** True only for a `write_plan`-sourced checklist (todo 898) - see this
   *  file's module doc for why TodoWrite never gets the affordance. */
  commentable: boolean;
  /** The owning session, for `add_step_comment`. Null (comments disabled in
   *  practice) if the footer was never tagged - defensive, not expected. */
  sessionId: string | null;
}

/** Set a row's icon + status class (and connector fill, when present). */
function applyTodoStepStatus(entry: TodoStepRow, status: TodoStepStatus): void {
  entry.status = status;
  // Rebuilt, not blindly reassigned: the two detail classes are owned by
  // setTodoStepDetail, and a plain className write drops them, so a step
  // would stop expanding the instant it changed status.
  const wasOpen = entry.row.classList.contains("todo-step--open");
  entry.row.className = `todo-step todo-step--${status}`;
  if (entry.detailEl) {
    entry.row.classList.add("todo-step--has-detail");
    if (wasOpen) entry.row.classList.add("todo-step--open");
  }
  let iconClass = "ph ph-circle";
  if (status === "active") iconClass = "ph ph-spinner-gap";
  else if (status === "done") iconClass = "ph-fill ph-check-circle";
  else if (status === "interrupted") iconClass = "ph ph-x-circle";
  entry.icon.innerHTML = `<i class="${iconClass}"></i>`;
  if (entry.connectorFill) {
    entry.connectorFill.style.height = status === "done" ? "100%" : "0%";
  }
  // A step that leaves `pending` with no comment ever queued can no longer
  // receive one - todo 898's whole value is commenting BEFORE the step
  // starts, so a button that would now deliver nowhere (or too late) is
  // worse than no button. A step that already has a noted comment keeps its
  // indicator; re-opening it is separately gated on `entry.status ===
  // "pending"` at click time.
  if (status !== "pending" && entry.comment && entry.comment.text === null) {
    closeCommentEditor(entry.comment);
    entry.comment.el.remove();
    entry.comment = null;
  }
}

/** Attach, update or drop a row's expandable detail line. */
function setTodoStepDetail(entry: TodoStepRow, detail: string | undefined): void {
  if (!detail) {
    entry.detailEl?.remove();
    entry.row.querySelector(".todo-step-caret")?.remove();
    entry.detailEl = null;
    entry.row.classList.remove("todo-step--has-detail", "todo-step--open");
    return;
  }
  if (!entry.detailEl) {
    const caret = document.createElement("i");
    caret.className = "ph ph-caret-down todo-step-caret";
    entry.row.appendChild(caret);
    const el = document.createElement("span");
    el.className = "todo-step-detail";
    entry.row.appendChild(el);
    entry.detailEl = el;
    entry.row.classList.add("todo-step--has-detail");
  }
  entry.detailEl.textContent = detail;
}

/** Create the trailing "leave a note" icon for a fresh row. Appended last so
 *  it sits after the detail caret when both are present. */
function createCommentAffordance(row: HTMLElement): TodoStepCommentState {
  const el = document.createElement("i");
  el.className = "ph ph-chat-circle-text todo-step-comment-btn";
  el.title = "Leave a note for when this step starts";
  row.appendChild(el);
  return { el, editor: null, textarea: null, text: null };
}

function closeCommentEditor(c: TodoStepCommentState): void {
  c.editor?.remove();
  c.editor = null;
  c.textarea = null;
}

/** Open (or, if already open, close) the inline note editor for a pending row. */
function toggleCommentEditor(entry: TodoStepRow, label: string, tc: TodoChecklistState): void {
  const c = entry.comment;
  if (!c) return;
  if (c.editor) {
    closeCommentEditor(c);
    return;
  }
  const editor = document.createElement("div");
  editor.className = "todo-step-comment-editor";
  const textarea = document.createElement("textarea");
  textarea.className = "todo-step-comment-textarea";
  textarea.placeholder = "Note for this step (e.g. \"skip this\")...";
  textarea.rows = 2;
  textarea.value = c.text ?? "";
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitStepComment(tc, entry, label);
    } else if (e.key === "Escape") {
      closeCommentEditor(c);
    }
  });
  const send = document.createElement("i");
  send.className = "ph ph-paper-plane-right todo-step-comment-send";
  send.title = "Send";
  editor.appendChild(textarea);
  editor.appendChild(send);
  entry.row.appendChild(editor);
  c.editor = editor;
  c.textarea = textarea;
  textarea.focus();
}

/** Submit (or, on an empty box, just cancel) the open editor. Optimistic: the
 *  row updates immediately, and the daemon write happens best-effort in the
 *  background - an offline/failed write only warns (same degrade as
 *  held-draft-sync.ts's add_held_message), since the note stays visible on
 *  the row either way (todo 898's "not silently lost" rule). */
function submitStepComment(tc: TodoChecklistState, entry: TodoStepRow, label: string): void {
  const c = entry.comment;
  if (!c || !c.textarea) return;
  const text = c.textarea.value.trim();
  closeCommentEditor(c);
  if (!text) return;
  c.text = text;
  c.el.className = "ph-fill ph-chat-circle-text todo-step-comment-btn todo-step-comment-btn--noted";
  c.el.title = text;
  if (tc.sessionId) {
    addStepComment(tc.sessionId, label, text).catch((e) => {
      console.warn("[step-comment] add_step_comment failed (offline?):", e);
    });
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
  // Delegated once on the list, not per row: rows are created and removed as
  // the plan changes, and a per-row listener would leak with them.
  stepsEl.addEventListener("click", (e) => {
    const tc = st.todoChecklist;
    if (!tc) return;
    const target = e.target as HTMLElement | null;
    const sendBtn = target?.closest?.(".todo-step-comment-send") as HTMLElement | null;
    if (sendBtn) {
      e.stopPropagation();
      const rowEl = sendBtn.closest(".todo-step") as HTMLElement | null;
      const label = rowEl?.dataset.stepLabel;
      const entry = label ? tc.rows.get(label) : undefined;
      if (entry && label) submitStepComment(tc, entry, label);
      return;
    }
    const commentBtn = target?.closest?.(".todo-step-comment-btn") as HTMLElement | null;
    if (commentBtn) {
      e.stopPropagation();
      const rowEl = commentBtn.closest(".todo-step") as HTMLElement | null;
      const label = rowEl?.dataset.stepLabel;
      const entry = label ? tc.rows.get(label) : undefined;
      // Re-opening to edit is only offered while still pending - once a step
      // starts, the moment for a comment to matter has passed.
      if (entry && label && entry.status === "pending") toggleCommentEditor(entry, label, tc);
      return;
    }
    const row = target?.closest?.(".todo-step--has-detail");
    if (row) row.classList.toggle("todo-step--open");
  });
  el.appendChild(stepsEl);
  if (st.metaRow) {
    st.metaRow.insertAdjacentElement("afterend", el);
  } else {
    st.footer.prepend(el);
  }
  st.todoChecklist = {
    el,
    stepsEl,
    settled: false,
    rows: new Map(),
    order: [],
    commentable: st.footer.dataset.planCommentable === "1",
    sessionId: st.footer.dataset.planSessionId || null,
  };
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
  steps: { label: string; status: TodoStepStatus; detail?: string }[],
): void {
  if (!st || st.settled) return;
  if (!st.todoChecklist) ensureTodoChecklist(st);
  const tc = st.todoChecklist;
  if (!tc) return;

  const seen = new Set<string>();
  for (const step of steps) {
    seen.add(step.label);
    let entry = tc.rows.get(step.label);
    const isNewRow = !entry;
    if (!entry) {
      const row = document.createElement("li");
      row.dataset.stepLabel = step.label;
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
      const comment = tc.commentable ? createCommentAffordance(row) : null;
      tc.stepsEl.appendChild(row);
      entry = { row, icon, connectorFill, status: "pending", detailEl: null, comment };
      tc.rows.set(step.label, entry);
      tc.order.push(step.label);
    }
    setTodoStepDetail(entry, step.detail);
    if (isNewRow || entry.status !== step.status) applyTodoStepStatus(entry, step.status);
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
  // Comments noted on rows that never activated must not vanish once the
  // collapse below throws the row DOM away - that IS the "never silently
  // lost" case todo 898 calls out, since a settled turn has nothing else
  // left to show them on.
  const noted: string[] = [];
  for (const entry of tc.rows.values()) {
    if (entry.status === "pending" || entry.status === "active") {
      applyTodoStepStatus(entry, "skipped");
    }
    if (entry.comment?.text) noted.push(entry.comment.text);
  }
  tc.settled = true;
  const chip = document.createElement("span");
  chip.className = "turn-chip";
  const icon = document.createElement("i");
  icon.className = "ph-fill ph-check-circle";
  chip.appendChild(icon);
  chip.appendChild(document.createTextNode(` ${total} step${total === 1 ? "" : "s"}`));
  if (noted.length > 0) {
    const note = document.createElement("i");
    note.className = "ph-fill ph-chat-circle-text todo-checklist-comment-noted";
    note.title = noted.length === 1 ? noted[0]! : noted.map((t, i) => `${i + 1}. ${t}`).join("\n");
    chip.appendChild(note);
  }
  tc.el.classList.add("todo-checklist-collapsed");
  tc.el.replaceChildren(chip);
}
