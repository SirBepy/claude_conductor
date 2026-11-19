/**
 * Who has a question open in a chat's window. A hidden sub asks, but its card
 * shows in its main chat's window (`display_session_id`), so one window can hold
 * several askers: each sub, and the main chat itself. This module turns the
 * parked slots (gating.ts) plus the per-asker sibling queues (index.ts) into the
 * ordered chips the question card shows, and picks which asker a window shows
 * first.
 */

import { state } from "../state";
import { MAIN_CHAT_LABEL } from "./asker-face";
import { isDeferredPrompt, parkedAskersFor } from "./gating";
import { queuedQuestionsFor, queuedSecretsFor } from "./index";
import type { AskerChip, QuestionRequestedPayload } from "./types";

export interface OpenAsker {
  askerId: string;
  /** Questions this asker has open: its slot's, plus its queued siblings'. A
   *  permission held behind another card counts as one. */
  count: number;
  /** A permission prompt held behind another asker's open card, not a question. */
  blocking?: boolean;
  /** The slot holds a secret request: one card among the others, listed in the
   *  picker and never ahead of a question, because Joe may not have the value yet. */
  secret?: boolean;
  /** Whether the slot itself holds an unanswered question, as opposed to only
   *  siblings queued behind an answered one. */
  slotOpen: boolean;
  /** Arrival order, the tie-break between askers with the same count. */
  seq: number;
  payload: QuestionRequestedPayload;
}

/** A secret waits behind every question in the picker and in who comes up next. */
const SECRET_RANK = 1000;

/** Where an asker sorts: its question count, a secret's slot after all of those. */
function rankOf(a: OpenAsker): number {
  return a.secret ? SECRET_RANK + a.count : a.count;
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
    if (prompt.kind === "secret") {
      // Always one more thing waiting, on screen or parked: unlike a permission it
      // is never "just answered" in the slot, because settling it clears the slot.
      const count = 1 + queuedSecretsFor(askerId).length + queuedQuestionsFor(askerId).reduce((n, q) => n + questionsIn(q), 0);
      out.push({ askerId, count, secret: true, slotOpen: true, seq: seqOf(askerId, prompt.payload as unknown as QuestionRequestedPayload), payload: prompt.payload as unknown as QuestionRequestedPayload });
      continue;
    }
    if (prompt.kind !== "question") {
      // A permission held back behind another card is one more thing waiting on
      // Joe, so it gets a chip. One that merely sits parked because its card is on
      // screen, or was just answered, does not.
      if (isDeferredPrompt(prompt.payload.id)) {
        out.push({
          askerId,
          count: 1,
          blocking: true,
          slotOpen: true,
          seq: seqOf(askerId, prompt.payload as unknown as QuestionRequestedPayload),
          payload: prompt.payload as unknown as QuestionRequestedPayload,
        });
      }
      continue;
    }
    const slotOpen = !prompt.answered;
    const queued = queuedQuestionsFor(askerId);
    const count = (slotOpen ? questionsIn(prompt.payload) : 0) + queued.reduce((n, q) => n + questionsIn(q), 0) + queuedSecretsFor(askerId).length;
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
    .sort((a, b) => rankOf(a) - rankOf(b) || a.seq - b.seq);
  for (const a of fresh) {
    const at = kept.findIndex((id) => rankOf(byId.get(id)!) > rankOf(a));
    if (at === -1) kept.push(a.askerId);
    else kept.splice(at, 0, a.askerId);
  }
  if (kept.length) _order.set(displayId, kept);
  else _order.delete(displayId);
  return kept.map((id) => byId.get(id)!);
}

function labelFor(a: OpenAsker, displayId: string): string {
  if (a.askerId === displayId) return MAIN_CHAT_LABEL;
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
    ...(a.blocking ? { blocking: true } : {}),
    ...(a.secret ? { secret: true } : {}),
  }));
}

/** The parked slot to show first when `displayId`'s window opens: a blocking
 *  permission prompt, then the first open asker in chip order (a secret request
 *  last, since Joe may not have the value yet and its card never holds a question
 *  back), then a question already marked answered (which shows nothing and is
 *  dropped, as it always was). Null when nothing is parked there. */
export function nextParkedAskerFor(displayId: string): string | null {
  const parked = parkedAskersFor(displayId);
  if (!parked.length) return null;
  const blocking = parked.find((p) => p.prompt.kind === "permission");
  if (blocking) return blocking.askerId;
  // A slot already answered (waiting on the daemon's resolve poll) is no use to
  // show while another asker still has a question to give.
  const first = orderedAskers(displayId).find((a) => a.slotOpen);
  if (first) return first.askerId;
  return parked[0]!.askerId;
}

/** Whether anything but the window's own chat has a prompt parked there, or a
 *  prompt was held back on purpose behind the card now up (a permission, or a
 *  question pushed aside for one). Only then does a window hold several askers,
 *  which is when finishing one card should bring up the next. */
export function hasSubPromptsIn(displayId: string): boolean {
  return parkedAskersFor(displayId).some((p) => p.askerId !== displayId || isDeferredPrompt(p.prompt.payload.id));
}
