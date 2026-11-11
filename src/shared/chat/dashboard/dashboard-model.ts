// The chat dashboard's data model (docs/chat-dashboard-design.md). Pure: it
// reads the rows the ChatRenderer already derived from the chat's events
// (send_message cards, question cards, report_turn_status calls, Joe's own
// messages) plus the latest write_plan call, and says what each zone shows.
// Nothing here touches the DOM, so the transcript renderer never learns the
// dashboard exists and every rule below is testable on plain arrays.
//
// Adding a card: add its derive function and one entry to ZONES below, then
// its renderer in src/views/sessions/chat-dashboard/dashboard-zones.ts (the
// view's registry is typed against ZoneId, so a zone with no renderer fails
// typecheck). A derive returns null when the zone has nothing to show, and the
// view then draws nothing for it.

import type { RenderedMessage } from "../chat-classifiers";
import { headlineOf, type MessageKind } from "../chat-message-kinds";
import { isOwnMessage, isReport, messageKindOf, stepFinished, type DashboardPlan, type PlanStep } from "./plan-record";
import { stripAuqAnswerBlock, stripAuqExtraBlock } from "../chat-event-to-message";
import type { PreviewMeta } from "../../../types/ipc.generated";
import type { Visual } from "../message-visuals";
import { buildAnswerItems, plainUserText, type AnswerItem, type AnswerSide } from "./answers-model";
import { buildSubsState, type SubCardItem, type SubsState } from "./subs-model";
import { changedFiles, extractFiles, extractLinks, type ChangedFile, type FileItem, type LinkItem } from "./links-model";
import { buildDraftsState, type DraftStoreSide, type DraftsState } from "./drafts-model";
import { cardQuestionTexts, findOpenCardForPrompt } from "../question-texts";

export const TURN_STATUS_TOOL = "mcp__cc_conductor__report_turn_status";

export {
  isOwnMessage, isReport, messageKindOf, recordPlan, stepFinished, turnCounts, TURN_ACTIONS_MAX,
  type DashboardPlan, type PlanStep, type PlanStepStatus, type TurnAction,
} from "./plan-record";

export interface DashboardInput {
  messages: readonly RenderedMessage[];
  /** Every plan of the chat, oldest first. */
  plans: readonly DashboardPlan[];
  /** A turn is running (or messages are held): the Plan card's empty state then
   *  says no plan yet instead of nothing planned. */
  busy?: boolean;
  /** What the daemon remembers for the Answers card, once loaded. */
  answers?: AnswerSide;
  /** This chat's subs, read from the instance list (subs-source.ts). */
  subs?: SubCardItem[];
  /** Clock for the Subchats card's one-hour fold; tests pass their own. */
  now?: number;
  /** This chat's previews and its subs' (list_previews scoped to the chat's
   *  family), newest first, once loaded. */
  previews?: readonly PreviewMeta[];
  /** The drafts store, once read (drafts-model.ts). */
  draftStore?: DraftStoreSide;
  /** Joe's per-section overrides (Settings > Chat defaults), by zone id. */
  sections?: Readonly<Record<string, boolean>>;
  /** The question card open by the message box for this chat, if any: Waiting
   *  on you leaves its copy out, so a question shows only where it is answered. */
  openCard?: OpenCardRef | null;
}

/** The prompt id and question strings of the answer card on screen. */
export interface OpenCardRef {
  id: string;
  questions: readonly string[];
}

/** Zones Joe can switch off or on in Settings. The value is the default when he
 *  has not chosen: Changes is off for him ("i know i wont be caring about
 *  them", 2026-11-10), the others are on. Any other zone always draws. */
export const SECTION_DEFAULTS: Readonly<Record<string, boolean>> = { links: true, preview: true, drafts: true, changes: false };

export function sectionOn(sections: Readonly<Record<string, boolean>> | undefined, id: string): boolean {
  return sections?.[id] ?? SECTION_DEFAULTS[id] ?? true;
}

/** Context every derive gets, computed once per derive pass. */
export interface DeriveCtx {
  input: DashboardInput;
  /** Index of Joe's latest own message, -1 when he has sent none. */
  lastJoe: number;
}

// ---- Row classifiers (the own-message ones live in plan-record.ts) ----------

/** Something Joe typed himself: not a peer's relayed message, and not only the
 *  machine-written answer to a question card. */
export function isJoeMessage(m: RenderedMessage): boolean {
  if (m.kind !== "user" || m.authorSessionId) return false;
  const rest = stripAuqExtraBlock(stripAuqAnswerBlock(m.content ?? []));
  return rest.some((b) => b.type === "image" || (b.type === "text" && b.text.trim() !== ""));
}

/** An ask_user_question card still waiting for Joe. */
export function isOpenQuestion(m: RenderedMessage): boolean {
  return m.kind === "question" && m.text === undefined && !m.failed;
}

function turnStatusOf(m: RenderedMessage): string | null {
  if (m.kind !== "tool_use" || m.tool !== TURN_STATUS_TOOL) return null;
  const s = (m.input as { status?: unknown } | null)?.status;
  return typeof s === "string" ? s : null;
}

function lastIndexWhere(msgs: readonly RenderedMessage[], pred: (m: RenderedMessage, i: number) => boolean, from = msgs.length - 1): number {
  for (let i = from; i >= 0; i--) if (pred(msgs[i]!, i)) return i;
  return -1;
}

// ---- Joe's message strip -------------------------------------------------------

export interface StripState {
  /** Joe's own messages, oldest first. */
  messages: RenderedMessage[];
}

export function deriveStrip(input: DashboardInput): StripState | null {
  const messages = input.messages.filter(isJoeMessage);
  return messages.length > 0 ? { messages } : null;
}

// ---- Zones -----------------------------------------------------------------------

export interface AnswersState {
  /** Every answer to one of Joe's questions, oldest first (answers-model.ts). */
  items: AnswerItem[];
}

/** Only replies to Joe's questions count (answers-model.ts isAnswerRow): a
 *  request's plan or report never lands here. The card itself
 *  (chat-dashboard/answers-card.ts) decides which one shows. It draws even with
 *  no answer yet, so + (new question) is there from the start: Answers and Plan
 *  are always on the dashboard (Joe, 2026-11-10). */
export function deriveAnswers({ input }: DeriveCtx): AnswersState {
  return { items: buildAnswerItems(input.messages, input.answers) };
}

export type WaitingItem =
  | { type: "blocker"; message: RenderedMessage }
  | { type: "do_this"; message: RenderedMessage }
  | { type: "question"; message: RenderedMessage; questions: string[]; figures: Visual[] };

export interface WaitingState {
  items: WaitingItem[];
  /** Any blocker: the zone draws red instead of amber. */
  blocked: boolean;
}


/** The tables and charts of the send_message that came with a question card:
 *  the nearest own message before it in the same stretch (Joe has not written
 *  in between and no other question sits between), so an approval question
 *  shows the figures it asks about. */
function figuresBefore(msgs: readonly RenderedMessage[], at: number): Visual[] {
  for (let i = at - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (isJoeMessage(m) || m.kind === "question") return [];
    if (isOwnMessage(m) && m.card?.visuals?.length) return m.card.visuals;
  }
  return [];
}

/** Blockers first (tinted red), then what only Joe can do, then open questions.
 *  A blocker or do_this counts only until Joe writes again, since his next
 *  message is how he answers it. A sub's blocker counts until that sub sends a
 *  later card. Open question cards count until they are answered, except the
 *  one open in the answer card by the message box (Joe reads it there). */
export function deriveWaiting({ input, lastJoe }: DeriveCtx): WaitingState | null {
  const msgs = input.messages;
  const blockers: WaitingItem[] = [];
  const doThis: WaitingItem[] = [];
  const questions: WaitingItem[] = [];
  // The one transcript card the answer popover stands for: by id, else (a
  // prompt from before the ids matched) the newest open card asking the same.
  const onScreen = input.openCard ? findOpenCardForPrompt(msgs, input.openCard.id, input.openCard.questions) : -1;
  msgs.forEach((m, i) => {
    if (isOwnMessage(m) && i > lastJoe) {
      const k = messageKindOf(m);
      if (k === "blocker") blockers.push({ type: "blocker", message: m });
      else if (k === "do_this") doThis.push({ type: "do_this", message: m });
    } else if (m.kind === "message" && m.subCard?.kind === "blocker" && !m.failed && !m.retracted) {
      const sub = m.subCard.sub_id;
      const later = !!sub && msgs.some((n, j) => j > i && n.subCard?.sub_id === sub);
      if (!later) blockers.push({ type: "blocker", message: m });
    } else if (isOpenQuestion(m) && i !== onScreen) {
      questions.push({ type: "question", message: m, questions: cardQuestionTexts(m), figures: figuresBefore(msgs, i) });
    }
  });
  const items = [...blockers, ...doThis, ...questions];
  return items.length > 0 ? { items, blocked: blockers.length > 0 } : null;
}

/** One job of the chat as the Plan card draws it: a plan with the messages
 *  around it, or a report that came with no plan. */
export interface PlanJob {
  /** Stable while the job lives: the Plan card keys its open step and its
   *  picked earlier plan on it. */
  key: string;
  plan: DashboardPlan | null;
  steps: PlanStep[];
  /** The latest `plan`-kind message of this job: its text leads the card. */
  lead: RenderedMessage | null;
  /** The job's report, once the turn that sent it closed. */
  result: RenderedMessage | null;
  /** One line naming the job in the earlier-plans list. */
  title: string;
  /** When it started (ms), null when nothing says. */
  startedAt: number | null;
}

/** What the card's foot says while no turn runs. */
export type IdleStatus =
  | { kind: "wait"; since: number | null }
  | { kind: "idle"; since: number | null };

export interface PlanState {
  /** empty: no job yet. current: the job in hand, running or just ended. last:
   *  Joe wrote after it ended and no new plan came, so it stays, dimmed, as the
   *  last job until one does (Joe, 2026-11-10: the plan never vanishes). */
  mode: "empty" | "current" | "last";
  job: PlanJob | null;
  /** Jobs before `job`, oldest first. */
  earlier: PlanJob[];
  status: IdleStatus;
  /** The shown job's steps, finished count, lead and report (empty when none). */
  steps: PlanStep[];
  done: number;
  lead: RenderedMessage | null;
  result: RenderedMessage | null;
}

/** Row timestamps arrive in seconds from history and in ms from live rows. */
export function rowMs(m: RenderedMessage): number {
  return !m.ts ? 0 : m.ts < 1e10 ? m.ts * 1000 : m.ts;
}

/** A report counts once the turn that sent it closed. A chat that never calls
 *  report_turn_status (an old or external one) has no closing signal, so its
 *  report counts at once. */
function reportClosed(msgs: readonly RenderedMessage[], r: number): boolean {
  if (!msgs.some((m) => turnStatusOf(m) !== null)) return true;
  for (let i = r + 1; i < msgs.length; i++) {
    const s = turnStatusOf(msgs[i]!);
    if (s !== null && s !== "working") return true;
  }
  return false;
}

const TITLE_MAX = 90;

function jobTitle(lead: RenderedMessage | null, joe: RenderedMessage | null, steps: readonly PlanStep[]): string {
  const raw = lead?.text ? headlineOf(lead.text) : joe ? plainUserText(joe) : steps[0]?.label ?? "";
  const t = raw.replace(/[*_`#>]/g, "").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** The job a plan stands for, and the row its rows stop at. They run from the
 *  plan's first call up to the Joe message that started the next plan (the next
 *  job's own plan message comes after it), and never past the first Joe message
 *  after the job's own report: a later report answers a follow-up, not this job.
 *  Its lead is a plan message after the Joe message that started it (later Joe
 *  messages answered its questions). */
function jobFor(msgs: readonly RenderedMessage[], plan: DashboardPlan, next: DashboardPlan | undefined): { job: PlanJob; end: number } {
  const at = Math.min(plan.at, msgs.length);
  let stop = msgs.length;
  if (next) {
    stop = Math.min(next.at, msgs.length);
    const nextAsk = lastIndexWhere(msgs, isJoeMessage, stop - 1);
    if (nextAsk >= at) stop = nextAsk;
  }
  const first = msgs.findIndex((m, i) => i >= at && i < stop && isReport(m) && reportClosed(msgs, i));
  if (first >= 0) {
    const after = msgs.findIndex((m, i) => i > first && i < stop && isJoeMessage(m));
    if (after >= 0) stop = after;
  }
  const joeAt = lastIndexWhere(msgs, isJoeMessage, at - 1);
  const leadAt = lastIndexWhere(msgs, (m, i) => i > joeAt && isOwnMessage(m) && messageKindOf(m) === "plan", stop - 1);
  const r = lastIndexWhere(msgs, (m, i) => i >= at && isReport(m), stop - 1);
  const lead = leadAt >= 0 ? msgs[leadAt]! : null;
  return { end: stop, job: {
    key: `p${plan.id}`,
    plan,
    steps: plan.steps,
    lead,
    result: r >= 0 && reportClosed(msgs, r) ? msgs[r]! : null,
    title: jobTitle(lead, joeAt >= 0 ? msgs[joeAt]! : null, plan.steps),
    startedAt: plan.startedAt,
  } };
}

/** A job with no write_plan, among the rows from `from` on: a report, or a
 *  plan message that came with no write_plan. A chat with no plan yet, or a
 *  follow-up after the last plan's job ended, is one. */
function planlessJob(msgs: readonly RenderedMessage[], lastJoe: number, from = 0): PlanJob | null {
  const r = lastIndexWhere(msgs, (m, i) => i >= from && isReport(m));
  const result = r >= 0 && reportClosed(msgs, r) ? msgs[r]! : null;
  const leadAt = lastIndexWhere(msgs, (m, i) => i >= from && i > lastJoe && isOwnMessage(m) && messageKindOf(m) === "plan");
  const lead = leadAt >= 0 ? msgs[leadAt]! : null;
  if (!result && !lead) return null;
  const anchor = result ?? lead!;
  const joeAt = lastIndexWhere(msgs, isJoeMessage, msgs.indexOf(anchor) - 1);
  const startedAt = joeAt >= 0 ? rowMs(msgs[joeAt]!) || null : null;
  return { key: `r${anchor.id ?? msgs.indexOf(anchor)}`, plan: null, steps: [], lead, result, title: jobTitle(lead, joeAt >= 0 ? msgs[joeAt]! : null, []), startedAt };
}

/** Waiting on Joe while a question card is open, otherwise idle since the
 *  chat's latest row. The view knows a live turn's end better than a row's
 *  stamp (live rows can carry none), so it may move `since` later. */
function idleStatus(msgs: readonly RenderedMessage[], plans: readonly DashboardPlan[]): IdleStatus {
  const q = lastIndexWhere(msgs, isOpenQuestion);
  if (q >= 0) return { kind: "wait", since: rowMs(msgs[q]!) || null };
  let since = 0;
  for (const m of msgs) since = Math.max(since, rowMs(m));
  // write_plan draws no row, so a step ticked after the last row counts too.
  for (const s of plans.at(-1)?.steps ?? []) since = Math.max(since, s.doneAt ?? 0, s.startedAt ?? 0);
  return { kind: "idle", since: since || null };
}

/** The Plan card is always drawn (docs/chat-dashboard-design.md "Plan card
 *  across a chat's life"). The latest job stays on it until a new plan
 *  replaces it; every job before that is one step back in its history. */
export function derivePlan({ input, lastJoe }: DeriveCtx): PlanState {
  const msgs = input.messages;
  const plans = input.plans;
  const built = plans.map((p, i) => jobFor(msgs, p, plans[i + 1]));
  const jobs = built.map((b) => b.job);
  // The last plan's job stops where a follow-up began; a report or plan message
  // after that is a planless job of its own, and the plan steps one back.
  const tailFrom = built.at(-1)?.end ?? 0;
  const tail = tailFrom < msgs.length ? planlessJob(msgs, lastJoe, tailFrom) : null;
  const job = tail ?? jobs.at(-1) ?? null;
  const earlier = tail ? jobs : jobs.slice(0, -1);
  let mode: PlanState["mode"] = "empty";
  if (job) {
    const resultAt = job.result ? msgs.indexOf(job.result) : -1;
    const allDone = job.steps.length > 0 && job.steps.every(stepFinished);
    // Ended and Joe has written since: a report before his message, or (no
    // report) every step finished before he wrote.
    const movedOn = resultAt >= 0 ? lastJoe > resultAt : allDone && !!job.plan && lastJoe > job.plan.lastAt;
    mode = movedOn ? "last" : "current";
  }
  const steps = job?.steps ?? [];
  return {
    mode,
    job,
    earlier,
    status: idleStatus(msgs, plans),
    steps,
    done: steps.filter(stepFinished).length,
    lead: job?.lead ?? null,
    result: job?.result ?? null,
  };
}

export interface CardListState {
  cards: RenderedMessage[];
}

/** The Subchats card (subs-model.ts has the rules): this chat's subs as avatars,
 *  from the instance list the view passes in, never from the transcript. An
 *  asking sub's question stays in Waiting on you as well. */
export function deriveSubchats({ input }: DeriveCtx): SubsState | null {
  return buildSubsState(input.subs ?? [], input.now ?? Date.now());
}

const NOTE_KINDS: ReadonlySet<MessageKind | "legacy"> = new Set(["call", "discovery", "handoff", "correction", "legacy"]);

/** Calls, discoveries, handoffs and corrections of the current job: none of
 *  them answers a question or ends the job, and Joe may still want to overrule
 *  a call. A legacy message (sent before kinds existed) could be anything, so
 *  it is a note rather than an answer. */
export function deriveNotes({ input, lastJoe }: DeriveCtx): CardListState | null {
  const cards = input.messages.filter((m, i) => i > lastJoe && isOwnMessage(m) && NOTE_KINDS.has(messageKindOf(m))).reverse();
  return cards.length > 0 ? { cards } : null;
}

export interface LinksState {
  links: LinkItem[];
  files: FileItem[];
}

/** Links and files: what the chat produced (a ticket, a PR, a CI run, sources)
 *  and the files it touched or showed, derived from its own rows
 *  (links-model.ts). It also hosts the three quick-view buttons, so it draws
 *  when it has links or files, and also once the chat has a plan, which is a
 *  job rather than a one-question chat: those buttons are then worth having
 *  even before the first link. A quick one-question chat still collapses. */
export function deriveLinks({ input }: DeriveCtx): LinksState | null {
  if (!sectionOn(input.sections, "links")) return null;
  const links = extractLinks(input.messages);
  const files = extractFiles(input.messages);
  if (links.length === 0 && files.length === 0 && input.plans.length === 0) return null;
  return { links, files };
}

export interface PreviewWindowState {
  /** The chat's (or its subs') newest preview. */
  newest: PreviewMeta;
  /** How many others the panel holds. */
  others: number;
}

/** The Preview window card: the newest preview as a small live tile that opens
 *  the preview panel. A comparison table is a preview like any other, so it
 *  lands here too instead of in a card of its own. */
export function derivePreviewWindow({ input }: DeriveCtx): PreviewWindowState | null {
  if (!sectionOn(input.sections, "preview")) return null;
  const list = input.previews ?? [];
  const newest = list[0];
  return newest ? { newest, others: list.length - 1 } : null;
}

/** Drafts: messages Claude wrote for Joe to send somewhere else (write_draft),
 *  one card per draft, newest open, copied ones folded (drafts-model.ts). On
 *  the left, since a draft is his to send, and it stays until he copies it,
 *  unlike Waiting on you, which clears when he writes again (2026-11-11). */
export function deriveDrafts({ input }: DeriveCtx): DraftsState | null {
  if (!sectionOn(input.sections, "drafts")) return null;
  return buildDraftsState(input.messages, input.draftStore);
}

export interface ChangesState {
  files: ChangedFile[];
}

/** Changes: files the chat edited since Joe last wrote. Off unless Joe turns it on. */
export function deriveChanges({ input, lastJoe }: DeriveCtx): ChangesState | null {
  if (!sectionOn(input.sections, "changes")) return null;
  const files = changedFiles(input.messages, lastJoe + 1);
  return files.length > 0 ? { files } : null;
}

export type Column = "left" | "right";

interface ZoneDef<T> {
  /** Left = what Joe must look at, right = what stays put. */
  column: Column;
  /** Sort order inside the column, lowest on top. Longer-lived cards sit higher. */
  order: number;
  derive(ctx: DeriveCtx): T | null;
}

function zone<T>(def: ZoneDef<T>): ZoneDef<T> {
  return def;
}

/** Every dashboard zone. Answers and Plan always sit on top of their column. */
export const ZONES = {
  answers: zone({ column: "left", order: 10, derive: deriveAnswers }),
  waiting: zone({ column: "left", order: 20, derive: deriveWaiting }),
  drafts: zone({ column: "left", order: 30, derive: deriveDrafts }),
  plan: zone({ column: "right", order: 10, derive: derivePlan }),
  subchats: zone({ column: "right", order: 20, derive: deriveSubchats }),
  notes: zone({ column: "right", order: 30, derive: deriveNotes }),
  preview: zone({ column: "right", order: 35, derive: derivePreviewWindow }),
  links: zone({ column: "right", order: 40, derive: deriveLinks }),
  changes: zone({ column: "right", order: 50, derive: deriveChanges }),
};

export type ZoneId = keyof typeof ZONES;
export type ZoneState<K extends ZoneId> = NonNullable<ReturnType<(typeof ZONES)[K]["derive"]>>;

export type DrawnZone = { [K in ZoneId]: { id: K; column: Column; state: ZoneState<K> } }[ZoneId];

export interface DashboardState {
  strip: StripState | null;
  /** Zones with something to show, each column's in its own order. */
  left: DrawnZone[];
  right: DrawnZone[];
}

export function deriveDashboard(input: DashboardInput): DashboardState {
  const ctx: DeriveCtx = { input, lastJoe: lastIndexWhere(input.messages, isJoeMessage) };
  const drawn: (DrawnZone & { order: number })[] = [];
  for (const id of Object.keys(ZONES) as ZoneId[]) {
    const def = ZONES[id] as ZoneDef<unknown>;
    const state = def.derive(ctx);
    if (state !== null) drawn.push({ id, column: def.column, state, order: def.order } as DrawnZone & { order: number });
  }
  drawn.sort((a, b) => a.order - b.order);
  const bare = ({ order: _o, ...z }: DrawnZone & { order: number }): DrawnZone => z as DrawnZone;
  return {
    strip: deriveStrip(input),
    left: drawn.filter((z) => z.column === "left").map(bare),
    right: drawn.filter((z) => z.column === "right").map(bare),
  };
}
