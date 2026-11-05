/**
 * Who has a question open in a chat's window. A hidden sub asks, but its card
 * shows in its main chat's window (`display_session_id`), so one window can hold
 * several askers: each sub, and the main chat itself. This module turns the
 * parked slots (gating.ts) plus the per-asker sibling queues (index.ts) into the
 * ordered chips the question card shows, and picks which asker a window shows
 * first.
 */

import { state } from "../state";
import { parkedAskersFor } from "./gating";
import { queuedQuestionsFor } from "./index";
import type { AskerChip, QuestionRequestedPayload } from "./types";

export interface OpenAsker {
  askerId: string;
  /** Questions this asker has open: its slot's, plus its queued siblings'. */
  count: number;
  /** Whether the slot itself holds an unanswered question, as opposed to only
   *  siblings queued behind an answered one. */
  slotOpen: boolean;
  /** Arrival order, the tie-break between askers with the same count. */
  seq: number;
  payload: QuestionRequestedPayload;
}

function questionsIn(p: QuestionRequestedPayload): number {
  return Array.isArray(p.questions) ? p.questions.length : 1;
}

// Arrival rank for a prompt that carries no daemon `seq` (a hand-built payload).
let _arrival = 0;
const _arrivalOf = new Map<string, number>();
function seqOf(askerId: string, payload: QuestionRequestedPayload): number {
  if (typeof payload.seq === "number") return payload.seq;
  const key = `${askerId}::${payload.id}`;
  let n = _arrivalOf.get(key);
  if (n === undefined) {
    n = _arrival++;
    _arrivalOf.set(key, n);
  }
  return n;
}

/** Askers with at least one unanswered question in `displayId`'s window. */
export function openAskersFor(displayId: string): OpenAsker[] {
  const out: OpenAsker[] = [];
  for (const { askerId, prompt } of parkedAskersFor(displayId)) {
    if (prompt.kind !== "question") continue;
    const slotOpen = !prompt.answered;
    const queued = queuedQuestionsFor(askerId);
    const count = (slotOpen ? questionsIn(prompt.payload) : 0) + queued.reduce((n, q) => n + questionsIn(q), 0);
    if (count === 0) continue;
    out.push({ askerId, count, slotOpen, seq: seqOf(askerId, prompt.payload), payload: prompt.payload });
  }
  return out;
}

// The order Joe sees, kept while a card is open: counts and arrivals move under
// him, and a chip that jumps away from the one he is about to click is worse than
// a slightly out-of-order list. A newcomer slots in by its own count among the
// chips already there and never moves them past each other.
const _order = new Map<string, string[]>();

/** Open askers, fewest questions first (Joe answers the simplest first), stable
 *  across calls until the window has none left. */
export function orderedAskers(displayId: string): OpenAsker[] {
  const live = openAskersFor(displayId);
  const byId = new Map(live.map((a) => [a.askerId, a]));
  const kept = (_order.get(displayId) ?? []).filter((id) => byId.has(id));
  const fresh = live
    .filter((a) => !kept.includes(a.askerId))
    .sort((a, b) => a.count - b.count || a.seq - b.seq);
  for (const a of fresh) {
    const at = kept.findIndex((id) => byId.get(id)!.count > a.count);
    if (at === -1) kept.push(a.askerId);
    else kept.splice(at, 0, a.askerId);
  }
  if (kept.length) _order.set(displayId, kept);
  else _order.delete(displayId);
  return kept.map((id) => byId.get(id)!);
}

function labelFor(a: OpenAsker, displayId: string): string {
  if (a.askerId === displayId) return "This chat";
  if (a.payload.sub_name) return a.payload.sub_name;
  const row = state.sessions.find((s) => s.session_id === a.askerId);
  return row?.name?.trim() || "Subchat";
}

/** The picker for a card asked by `activeAskerId`, or null when fewer than two
 *  askers have something open (one chat's card needs no picker). */
export function askerChips(displayId: string, activeAskerId: string): AskerChip[] | null {
  const askers = orderedAskers(displayId);
  if (askers.length < 2) return null;
  return askers.map((a) => ({
    askerId: a.askerId,
    label: labelFor(a, displayId),
    count: a.count,
    isMain: a.askerId === displayId,
    active: a.askerId === activeAskerId,
  }));
}

/** The parked slot to show first when `displayId`'s window opens: a blocking
 *  permission or secret prompt, then the first open question in chip order, then
 *  a question already marked answered (which shows nothing and is dropped, as it
 *  always was). Null when nothing is parked there. */
export function nextParkedAskerFor(displayId: string): string | null {
  const parked = parkedAskersFor(displayId);
  if (!parked.length) return null;
  const blocking = parked.find((p) => p.prompt.kind !== "question");
  if (blocking) return blocking.askerId;
  // A slot already answered (waiting on the daemon's resolve poll) is no use to
  // show while another asker still has a question to give.
  const first = orderedAskers(displayId).find((a) => a.slotOpen);
  if (first) return first.askerId;
  return parked[0]!.askerId;
}

/** Whether anything but the window's own chat has a prompt parked there. Only
 *  then does a window hold several askers, which is when finishing one card
 *  should bring up the next. */
export function hasSubPromptsIn(displayId: string): boolean {
  return parkedAskersFor(displayId).some((p) => p.askerId !== displayId);
}
