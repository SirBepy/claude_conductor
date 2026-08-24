// Tool-lifecycle handlers (tool_use, tool_result) split out of
// chat-event-handler.ts (ai_todo 746): the one cluster in that file
// independent of the message/turn handlers around it. handleChatEvent still
// dispatches into these exactly as before; behavior is byte-identical.

import type { ChatEvent } from "../../types/ipc.generated";
import { eventToRenderedMessage } from "./chat-event-to-message";
import { parseFileEdit } from "./file-edits";
import { canonicalTool } from "./tool-meta";
import {
  tryHandleQuestionToolUse,
  tryHandleQuestionResult,
} from "./chat-question-card";
import { describeActivity } from "./chat-dom-renderer";
import { resolveOrdinalIn } from "./chat-pagination";
import type { ChatRenderer } from "./chat-renderer";

// Structurally identical to chat-event-handler.ts's own (unexported)
// EventOutcome - duplicated rather than exported so this split adds no new
// export surface to that file (ai_todo 746's "empty diff" export bar).
interface EventOutcome {
  touched: boolean;
  coalesce: boolean;
}

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
  // TodoWrite drives the step-checklist that replaces the visual role of
  // the <cc-progress:N/M> marker bar (chat-tools.css .todo-checklist).
  // Renders straight into the turn footer via turnFooters - never a
  // message row.
  if (ev.tool_name === "TodoWrite" && !ev.parent_tool_use_id) {
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
    if (!r.hydrating) {
      const active = todos.find((t) => t.status === "in_progress");
      r.onTodoActivityUpdate?.(active?.activeForm ?? null);
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
