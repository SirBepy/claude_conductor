import type { Instance } from "../../types/ipc.generated";
import { tierLabel } from "../../shared/model-name";
import { isQuietPrompt, isSubchatsOn, parkedAskersFor } from "./permission-modal/gating";
import { questionProgressFor } from "./question-progress";
import { sessionSubtitle } from "./sessions-helpers";
import { planProgress } from "./sidebar-ring";

/** Red asks for Joe, yellow is working, green is finished or closing. Queued is
 *  also yellow, but it has not started: the daemon holds it behind another sub
 *  (`after`) and says so in `progress.waiting_for`. */
export type SubKind = "asking" | "working" | "queued" | "finished";

export interface SubStatus {
  id: string;
  name: string;
  kind: SubKind;
  /** "2 of 5 answered", "step 3 of 6", "finished": the hover card's right column. */
  progress: string;
  /** The model and effort it runs at, "Sonnet high", quiet beside its name. Empty
   *  when the row carries no model. */
  tier: string;
  /** Being closed. It reads green like a finished one, but it is not finished yet:
   *  the work it was doing may still be settling. */
  closing: boolean;
}

/** What a main chat's sidebar row shows about the subs behind it. A main chat
 *  has no state of its own to colour a ring with (one sub can be asking while
 *  another works and a third closes), so the row reports counts instead. */
export interface MainChatInfo {
  /** Every sub, asking first, then working, then finished. */
  subs: SubStatus[];
  /** Red dots: one per asking sub, plus one for the main chat's own question. */
  askingDots: number;
  /** Rows the hover lists: the subs, plus this chat when it asks. */
  hoverRows: SubStatus[];
  /** At least one sub exists and every one has finished. */
  allFinished: boolean;
}

const KIND_ORDER: Record<SubKind, number> = { asking: 0, working: 1, queued: 2, finished: 3 };

/** Ids with a card waiting in `mainId`'s window: the parked slots (a sub's card
 *  is parked under the sub's own id, shown in its main chat), plus the registry's
 *  `awaiting` for an asker whose card this window has not seen yet (the phone
 *  between two polls). A slot already marked answered is not asking. */
function askingIds(main: Instance, subs: readonly Instance[]): Set<string> {
  const out = new Set<string>();
  for (const { askerId, prompt } of parkedAskersFor(main.session_id)) {
    if (prompt.kind === "question" && prompt.answered) continue;
    // A quiet card (a decisions checkup) is not a question for Joe: no red dot.
    if (isQuietPrompt(prompt)) continue;
    out.add(askerId);
  }
  // A finished sub is frozen and idle, so a stale `awaiting` on it is not a live ask.
  for (const s of [main, ...subs]) if (s.awaiting === "question" && !s.subchat_finished) out.add(s.session_id);
  return out;
}

function progressText(s: Instance, kind: SubKind): string {
  if (kind === "asking") {
    const q = questionProgressFor(s.session_id);
    return q && q.total > 0 ? `${q.answered} of ${q.total} answered` : "needs your input";
  }
  if (s.closing) return "closing";
  if (kind === "finished") return "finished";
  if (kind === "queued") return s.progress?.waiting_for ?? "queued";
  // A paused sub is neither working nor stuck, and "working" would be false.
  if (s.frozen) return "paused";
  if (s.rate_limited_resets_at != null && Number(s.rate_limited_resets_at) * 1000 > Date.now()) return "rate limited";
  const p = planProgress(s.progress?.plan);
  // The step being worked is the one after the last done: "step 3 of 6" while two are done.
  return p ? `step ${Math.min(p.done + 1, p.total)} of ${p.total}` : "working";
}

/** The sub rows of one main chat. `sessions` is the full unfiltered list
 *  (`state.sessions`): the sidebar's own list drops the subs. */
export function mainChatInfo(main: Instance, sessions: readonly Instance[]): MainChatInfo {
  const subInstances = sessions.filter((s) => s.subchat_of === main.session_id);
  const asking = askingIds(main, subInstances);
  const subs: SubStatus[] = subInstances.map((s) => {
    const kind: SubKind = asking.has(s.session_id)
      ? "asking"
      : s.subchat_finished || s.closing
        ? "finished"
        : s.progress?.waiting_for
          ? "queued"
          : "working";
    return { id: s.session_id, name: sessionSubtitle(s), kind, progress: progressText(s, kind), tier: tierLabel(s.model, s.effort), closing: !!s.closing };
  }).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const ownAsking = asking.has(main.session_id);
  const hoverRows = ownAsking
    ? [{ id: main.session_id, name: "This chat", kind: "asking" as const, progress: progressText(main, "asking"), tier: "", closing: false }, ...subs]
    : subs;
  return {
    subs,
    askingDots: subs.filter((s) => s.kind === "asking").length + (ownAsking ? 1 : 0),
    hoverRows,
    // A closing sub is not finished yet, so the ring stays off green until it is gone.
    allFinished: subs.length > 0 && subs.every((s) => s.kind === "finished" && !s.closing),
  };
}

/** Whether a chat carries a sub summary on its row: the mode is on, or it still has
 *  subs from before it was turned off. Turning the mode off only stops new spawns;
 *  running subs stay tied to the chat, so their dots, count and hover must stay too.
 *  Which group the row sits in is decided by the mode alone. */
export function showsSubs(sessionId: string, sessions: readonly Instance[]): boolean {
  return isSubchatsOn(sessionId) || sessions.some((s) => s.subchat_of === sessionId);
}
