import type { Instance } from "../../types/ipc.generated";
import { tierLabel } from "../../shared/model-name";
import { isQuietPrompt, isSubchatsOn, parkedAskersFor } from "./permission-modal/gating";
import { questionProgressFor } from "./question-progress";
import { sessionSubtitle } from "./sessions-helpers";
import { planProgress } from "./sidebar-ring";
import { localTime } from "../../shared/formatters";
import type { SubCardKind, SubHover } from "../../shared/chat/dashboard/subs-model";

/** Red asks for Joe, yellow is working, green is finished or closing. The four
 *  states that are NOT progressing (queued, paused, usage limit, stopped without
 *  finishing) draw a dim ring and a corner glyph instead of yellow, so a ring
 *  that looks alive always means a running turn. */
export type SubKind = SubCardKind;

/** The `progress` fields the daemon added for the honest sub states
 *  (types/project.rs `SessionProgress`). Read through this view until
 *  `ipc.generated.ts` is regenerated with them; the shapes match, so the cast
 *  goes away without a code change. In memory on the daemon, so all optional. */
interface SubProgressFacts {
  queue_place?: number | null;
  queue_behind?: string | null;
  stopped_unfinished?: boolean | null;
  last_action?: string | null;
  last_action_at?: string | null;
  parked?: boolean | null;
}
const facts = (s: Instance): SubProgressFacts => (s.progress ?? {}) as SubProgressFacts;

export interface SubStatus {
  id: string;
  name: string;
  kind: SubKind;
  /** "2 of 5 answered", "step 3 of 6", "finished": the hover card's right column. */
  progress: string;
  /** The model and effort it runs at, "Sonnet high", quiet beside its name. Empty
   *  when the row carries no model. */
  tier: string;
  /** The hover card's lines (state in words, step, last action, queue place). */
  hover: SubHover;
  /** ISO start of the sub's row, for the hover card's time running. */
  startedAt: string | null;
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
  /** At least one sub has a turn running right now: the main chat's ring glows. A
   *  queued, paused, usage-limited or stopped sub does not count. */
  anyWorking: boolean;
  /** Joe picked "Wait for them" on the close card: the daemon flags the chat
   *  `closing` and closes it when its last running sub ends. It stays in Main chats
   *  (it is not on its way out yet) with a quiet note, on every surface. */
  closesWhenSubsFinish: boolean;
}

const KIND_ORDER: Record<SubKind, number> = { asking: 0, working: 1, queued: 2, paused: 3, limited: 4, stopped: 5, finished: 6 };

/** When a usage-limited sub resumes (epoch ms), or null when it is not limited or the reset passed. */
function limitResetsAt(s: Instance): number | null {
  if (s.rate_limited_resets_at == null) return null;
  const at = Number(s.rate_limited_resets_at) * 1000;
  return at > Date.now() ? at : null;
}

/** Which state a sub is in. Order matters: asking first, a finished sub next, then
 *  what keeps a live sub from progressing, and `working` only when nothing does. */
function kindOf(s: Instance, asking: ReadonlySet<string>): SubKind {
  if (asking.has(s.session_id)) return "asking";
  if (s.subchat_finished || s.closing) return "finished";
  if (s.progress?.waiting_for) return "queued";
  if (s.frozen || facts(s).parked === true) return "paused";
  if (limitResetsAt(s) !== null) return "limited";
  if (facts(s).stopped_unfinished === true && !s.busy) return "stopped";
  return "working";
}

const NO_HOVER: SubHover = { stateWord: "", step: null, action: null, queue: null, resetsAt: null, gaming: false };

const STATE_WORD: Record<SubKind, string> = {
  asking: "Needs your input", working: "Working", queued: "Queued", paused: "Paused", limited: "Usage limit",
  stopped: "Stopped without finishing", finished: "Finished",
};

/** What the avatar's hover card says about one sub, read off its row. */
function subHoverOf(s: Instance, kind: SubKind): SubHover {
  const f = facts(s);
  const plan = s.progress?.plan ?? null;
  const p = planProgress(plan);
  const active = plan?.find((st) => st.status === "active");
  const at = Date.parse(f.last_action_at ?? "");
  return {
    stateWord: s.closing ? "Closing" : STATE_WORD[kind],
    // A step line only means something for a sub that has started and not finished.
    step: p && kind !== "finished" && kind !== "queued" ? { n: Math.min(p.done + 1, p.total), total: p.total, text: active?.text ?? "" } : null,
    action: f.last_action && !Number.isNaN(at) ? { text: f.last_action, at } : null,
    queue: kind === "queued" ? { waitingFor: s.progress?.waiting_for ?? null, place: f.queue_place ?? null, behind: f.queue_behind ?? null } : null,
    resetsAt: kind === "limited" ? limitResetsAt(s) : null,
    gaming: kind === "paused" && f.parked === true && !s.frozen,
  };
}

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
  if (kind === "paused") return facts(s).parked === true && !s.frozen ? "paused by gaming mode" : "paused";
  if (kind === "limited") {
    const at = limitResetsAt(s);
    return at === null ? "usage limit" : `usage limit, resets ${localTime(new Date(at))}`;
  }
  if (kind === "stopped") return "stopped without finishing";
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
    const kind = kindOf(s, asking);
    return {
      id: s.session_id, name: sessionSubtitle(s), kind, progress: progressText(s, kind), tier: tierLabel(s.model, s.effort),
      closing: !!s.closing, hover: subHoverOf(s, kind), startedAt: s.started_at ?? null,
    };
  }).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  // `closing` with a sub still running can only be the wait: a close with running subs
  // is held behind the card, and a plain close with none moves the row to Closing.
  const closesWhenSubsFinish = !!main.closing && subInstances.some((s) => !s.subchat_finished && !s.ended_at);
  const ownAsking = asking.has(main.session_id);
  const ownRows: SubStatus[] = [];
  if (ownAsking) ownRows.push({ id: main.session_id, name: "This chat", kind: "asking", progress: progressText(main, "asking"), tier: "", closing: false, hover: NO_HOVER, startedAt: null });
  if (closesWhenSubsFinish) ownRows.push({ id: main.session_id, name: "This chat", kind: "finished", progress: "closing when subs finish", tier: "", closing: false, hover: NO_HOVER, startedAt: null });
  // A finished sub is resumable from the header list; the hover stays about what is happening now.
  // A closing sub reads as "finished" but is still shutting down, so it stays listed.
  const hoverRows = [...ownRows, ...subs.filter((s) => s.kind !== "finished" || s.closing)];
  return {
    subs,
    askingDots: subs.filter((s) => s.kind === "asking").length + (ownAsking ? 1 : 0),
    hoverRows,
    // A closing sub is not finished yet, so the ring stays off green until it is gone.
    allFinished: subs.length > 0 && subs.every((s) => s.kind === "finished" && !s.closing),
    anyWorking: subs.some((s) => s.kind === "working"),
    closesWhenSubsFinish,
  };
}

/** Whether a chat carries a sub summary on its row: the mode is on, or it still has
 *  subs from before it was turned off. Turning the mode off only stops new spawns;
 *  running subs stay tied to the chat, so their dots, count and hover must stay too.
 *  Which group the row sits in is decided by the mode alone. */
export function showsSubs(sessionId: string, sessions: readonly Instance[]): boolean {
  return isSubchatsOn(sessionId) || sessions.some((s) => s.subchat_of === sessionId);
}
