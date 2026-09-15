// Tool-lifecycle handlers (tool_use, tool_result) split out of
// chat-event-handler.ts (ai_todo 746): the one cluster in that file
// independent of the message/turn handlers around it. handleChatEvent still
// dispatches into these exactly as before; behavior is byte-identical.

import type { ChatEvent } from "../../types/ipc.generated";
import { eventToRenderedMessage } from "./chat-event-to-message";
import { parseFileEdit } from "./file-edits";
import {
  BUILTIN_TODO_WRITE_TOOL,
  canonicalTool,
  isShowPreviewTool,
  MCP_WRITE_PLAN_TOOL,
} from "./tool-meta";
import { previewFieldsOf } from "./chat-preview-card";
import {
  tryHandleQuestionToolUse,
  tryHandleQuestionResult,
} from "./chat-question-card";
import { describeActivity } from "./chat-dom-renderer";
import { resolveOrdinalIn } from "./chat-pagination";
import { descOf } from "./tool-strip-subagents";
import type { ChatRenderer } from "./chat-renderer";

// Structurally identical to chat-event-handler.ts's own (unexported)
// EventOutcome - duplicated rather than exported so this split adds no new
// export surface to that file (ai_todo 746's "empty diff" export bar).
interface EventOutcome {
  touched: boolean;
  coalesce: boolean;
}

/** write_plan's step vocabulary. Narrower than TodoStepStatus: "interrupted"
 *  is set by the renderer on cancel, never declared by the model. */
const PLAN_STATUSES = ["pending", "active", "done", "skipped"] as const;
type PlanStatus = (typeof PLAN_STATUSES)[number];

// RULE (raised by /code-check on 9a510e3b, still not enforced in code): a
// session must call EITHER write_plan OR TodoWrite for its checklist in a
// given turn, never both. They share the rendered checklist but not their
// keying - write_plan replaces the whole row set on every call, TodoWrite
// diffs against `turnTodosBaseline`, which write_plan never seeds - so both
// firing in one turn would key rows off two different label sets and render
// a mixed/duplicated list. Doubly true once a row carries a step comment
// (todo 898): the affordance only exists on a write_plan row
// (`footer.dataset.planCommentable`), so a step re-declared through
// TodoWrite would silently lose it. Unreachable in practice today (a session
// rarely has both tools available at once) - documented here rather than
// enforced, since the enforcement point (rejecting/coalescing the second
// tool's call) has no natural owner yet.

export function handleToolUseEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "tool_use" }>,
  ts: number,
): EventOutcome {
  if (tryHandleQuestionToolUse(r, ev, ts)) return { touched: true, coalesce: false };
  // Explicit inbox message: the AI's opt-in way to surface a chat bubble
  // (vs. narration tool calls, hidden by default - see message-filter-pref.ts).
  if (ev.tool_name === "mcp__cc_conductor__send_message" && !ev.parent_tool_use_id) {
    const text = typeof (ev.input as { text?: unknown })?.text === "string"
      ? (ev.input as { text: string }).text : "";
    r.messages.push({ kind: "message", text, id: ev.id, ts, parentToolUseId: null });
    return { touched: true, coalesce: false };
  }
  // Pushed HTML the user is meant to LOOK at: its own centered card row, not
  // narration. The rail still gets the same snapshot via the daemon push.
  if (isShowPreviewTool(ev.tool_name) && !ev.parent_tool_use_id) {
    r.messages.push({ ...previewFieldsOf(ev.input), kind: "preview", id: ev.id, ts, parentToolUseId: null });
    return { touched: true, coalesce: false };
  }
  // Revise/retract a message Claude already sent (see resolveOrdinalIn in
  // chat-pagination.ts for the addressing scheme and its window). Edit is a
  // silent in-place swap; retract leaves a thin struck placeholder. Either
  // way the row clears `dimmed`, so answering an interrupt un-dims it.
  if (ev.tool_name === "mcp__cc_conductor__update_message" && !ev.parent_tool_use_id) {
    r._updateMsgToolUseIds.add(ev.id);
    const input = (ev.input ?? {}) as { message?: unknown; text?: unknown; retract?: unknown };
    const idx = resolveOrdinalIn(r.messages, typeof input.message === "number" ? input.message : NaN);
    if (idx >= 0) {
      const prev = r.messages[idx]!;
      r.messages[idx] = input.retract === true
        ? { ...prev, retracted: true, dimmed: false }
        : { ...prev, text: typeof input.text === "string" ? input.text : prev.text, dimmed: false };
      r.dirtyIndices.add(idx);
    }
    return { touched: true, coalesce: false };
  }
  // write_plan drives the same checklist as TodoWrite below, with one
  // difference: EVERY step renders on every call instead of being diffed
  // against a baseline, so step 4 can be objected to while step 1 runs.
  if (ev.tool_name === MCP_WRITE_PLAN_TOOL && !ev.parent_tool_use_id) {
    r._todoWriteToolUseIds.add(ev.id);
    const rawSteps = (ev.input as { steps?: { text?: unknown; status?: unknown; detail?: unknown }[] } | null)?.steps;
    const steps = (Array.isArray(rawSteps) ? rawSteps : [])
      .filter((s) => typeof s?.text === "string" && s.text.trim() !== "")
      .map((s) => ({
        label: s.text as string,
        // An unknown status renders pending rather than dropping the row: a
        // step the user cannot see is worse than one shown as not-started.
        status: PLAN_STATUSES.includes(s.status as PlanStatus) ? (s.status as PlanStatus) : "pending",
        detail: typeof s.detail === "string" && s.detail.trim() !== "" ? s.detail : undefined,
      }));
    if (r.activeTurnChipKey !== null && steps.length > 0) {
      // Tag the footer BEFORE ensureTodoChecklist creates the checklist off
      // it (todo 898): turn-todo-checklist.ts reads these two attributes at
      // creation to decide whether a row gets the comment affordance and,
      // if so, which session `add_step_comment` targets. A plain `data-*`
      // attribute on the shared footer element, not a TurnFooterState field
      // or a TurnFooterRegistry method - this file can touch the footer's
      // own DOM, but turn-chips.ts (owns TurnFooterState/the registry) is a
      // different lane's file this cycle.
      const footer = r.turnFooters.getOrCreateFooter(r.activeTurnChipKey);
      footer.dataset.planCommentable = "1";
      footer.dataset.planSessionId = r.sessionId ?? "";
      r.turnFooters.ensureTodoChecklist(r.activeTurnChipKey);
      r.turnFooters.updateTodoSteps(r.activeTurnChipKey, steps);
    }
    r.lastTodoActivity = steps.find((s) => s.status === "active")?.label ?? null;
    if (!r.hydrating) r.onTodoActivityUpdate?.(r.lastTodoActivity);
    return { touched: true, coalesce: false };
  }
  // TodoWrite drives the step-checklist that replaces the visual role of
  // the <cc-progress:N/M> marker bar (chat-tools.css .todo-checklist).
  // Renders straight into the turn footer via turnFooters - never a
  // message row.
  if (ev.tool_name === BUILTIN_TODO_WRITE_TOOL && !ev.parent_tool_use_id) {
    r._todoWriteToolUseIds.add(ev.id);
    const rawTodos = (ev.input as { todos?: { content: string; status: string; activeForm?: string }[] } | null)?.todos;
    const todos = Array.isArray(rawTodos) ? rawTodos : [];
    let steps: { label: string; status: "pending" | "active" | "done" }[];
    if (r.hydrating && r.lastTodosSnapshot === null) {
      // Cold-reopen degrade: first TodoWrite seen in a bulk-load batch
      // with no prior snapshot in the loaded window - render a flat
      // settled checklist (no diff, no new/carryover distinction). No
      // special no-animation handling needed: hydrating renders happen
      // while the transcript is hidden (revealTranscript), so any CSS
      // animation on these rows plays out unseen before the reveal.
      steps = todos.map((t) => ({
        label: t.content,
        status: t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending",
      }));
    } else {
      if (r.turnTodosBaseline === null) {
        r.turnTodosBaseline = r.lastTodosSnapshot ? r.lastTodosSnapshot.map((b) => ({ ...b })) : [];
      }
      const baseline = r.turnTodosBaseline;
      steps = [];
      for (const t of todos) {
        const baseEntry = baseline.find((b) => b.content === t.content);
        if (!baseEntry) {
          steps.push({
            label: t.content,
            status: t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending",
          });
        } else if (baseEntry.status !== t.status) {
          // Changed-status entry: never mapped back to "pending" (a
          // regression to pending can't happen under TodoWrite's normal
          // pending -> in_progress -> completed progression; "active" is
          // the fallback if it somehow did - judgment call, unpinned by
          // the spec).
          steps.push({
            label: t.content,
            status: t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "active",
          });
        }
        // else: identical content+status to baseline - carryover noise, filtered out.
      }
    }
    if (r.activeTurnChipKey !== null) {
      r.turnFooters.ensureTodoChecklist(r.activeTurnChipKey);
      r.turnFooters.updateTodoSteps(r.activeTurnChipKey, steps);
    }
    r.lastTodosSnapshot = todos.map((t) => ({ content: t.content, status: t.status }));
    {
      const active = todos.find((t) => t.status === "in_progress");
      r.lastTodoActivity = active?.activeForm ?? null;
      if (!r.hydrating) {
        r.onTodoActivityUpdate?.(active?.activeForm ?? null);
      }
    }
    return { touched: true, coalesce: false };
  }
  r.messages.push({
    kind: "tool_use",
    tool: ev.tool_name,
    input: ev.input,
    id: ev.id,
    ts,
    parentToolUseId: ev.parent_tool_use_id ?? null,
  });
  // Agent rail (todo 899): a live dot per top-level Task/Agent spawn, and the
  // dot's own "what it's doing right now" line from its children. Scoped to
  // ONE level - a nested Task (a subagent spawning another) just becomes a
  // generic activity line on its parent's dot rather than a second dot, the
  // same "in-turn, no containment invented" boundary the todo draws for the
  // checklist relationship.
  if (r.activeTurnChipKey !== null) {
    if ((ev.tool_name === "Task" || ev.tool_name === "Agent") && !ev.parent_tool_use_id) {
      r.turnFooters.addAgentDot(r.activeTurnChipKey, ev.id, descOf(ev.input), r.lastTodoActivity);
    } else if (ev.parent_tool_use_id) {
      r.turnFooters.updateAgentDotActivity(r.activeTurnChipKey, ev.parent_tool_use_id, describeActivity(ev.tool_name, ev.input));
    }
  }
  const view = parseFileEdit(ev.tool_name, ev.input);
  if (view) {
    r.fileEdits.push(view);
    // Suppressed during history replay so the header badge doesn't count
    // up; the final total is fired once when bulkLoadEvents finishes.
    if (!r.hydrating) r.onFileEditsChanged?.(r.getFileEdits());
  }
  {
    const t = r.tallyState.tallyToolUse(ev.tool_name, ev.input, ev.id);
    if (t) r.onToolTally?.(t);
  }
  if (!r.hydrating && ev.tool_name === "Skill") {
    const inp = ev.input as Record<string, unknown>;
    if (typeof inp?.skill === "string" && inp.skill === "next-ai-prompt") {
      r._nextAiPromptPending = true;
    }
  }
  r.activityToolCanon = canonicalTool(ev.tool_name);
  r.setActivity(describeActivity(ev.tool_name, ev.input));
  r.outstandingActivityToolIds.add(ev.id);
  return { touched: true, coalesce: false };
}

export function handleToolResultEvent(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "tool_result" }>,
): EventOutcome {
  // TodoWrite's tool_result carries no user-facing content - absorb it
  // silently (no message row, no tool tally bump), mirroring how the AUQ
  // branch below absorbs its own result but simpler: no card to update.
  if (r._todoWriteToolUseIds.delete(ev.tool_use_id)) return { touched: true, coalesce: false };
  if (r._updateMsgToolUseIds.delete(ev.tool_use_id)) return { touched: true, coalesce: false };
  if (tryHandleQuestionResult(r, ev)) return { touched: true, coalesce: false };
  // Agent rail (todo 899): a Task/Agent's own result finishes its dot. A
  // no-op for every other tool_use_id (not a live dot at all).
  if (r.activeTurnChipKey !== null) r.turnFooters.finishAgentDot(r.activeTurnChipKey, ev.tool_use_id);
  // Ack for a send_message call: text already came from the tool_use
  // input, so absorb silently - no visible tool_result row. A REJECTED send
  // must also drop the bubble: the row is built from the tool_use input, so
  // without this it renders anyway and the shortened retry stacks a
  // near-duplicate underneath it.
  const mIdx = r.messages.findIndex((m) => m.kind === "message" && m.id === ev.tool_use_id);
  if (mIdx >= 0) {
    if (ev.is_error) {
      r.messages[mIdx] = { ...r.messages[mIdx]!, failed: true };
      r.dirtyIndices.add(mIdx);
    }
    return { touched: true, coalesce: false };
  }
  // Built by the shared converter, not a literal: this path used to drop
  // output_truncated/full_seq, so a truncated result on the initial hydrate
  // rendered a cut-off preview with no "Load full output" button (todo 738).
  const rendered = eventToRenderedMessage(ev);
  if (rendered) r.messages.push(rendered);
  // Only idle the label once no tool from this turn is outstanding (see
  // outstandingActivityToolIds) - text stays, idle:true just flags it so a
  // fast result doesn't flash "Thinking...". keepChip only clears the
  // highlight; the chip keeps pulsing till the next tool_use or close.
  if (r.outstandingActivityToolIds.delete(ev.tool_use_id) && r.outstandingActivityToolIds.size === 0) {
    r.setActivity(r.lastActivity, { keepChip: true, idle: true });
  }
  // The tally counts didn't change, but a result can complete a custom
  // view (e.g. an AskUserQuestion answer): nudge the statusline so an open
  // popover re-renders from the now-updated messages.
  r.onToolTally?.(r.tallyState.build());
  return { touched: true, coalesce: false };
}
