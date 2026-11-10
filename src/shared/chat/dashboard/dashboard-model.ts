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
import type { MessageKind } from "../chat-message-kinds";
import { stripAuqAnswerBlock, stripAuqExtraBlock } from "../chat-event-to-message";
import { buildAnswerItems, type AnswerItem, type AnswerSide } from "./answers-model";

export const TURN_STATUS_TOOL = "mcp__cc_conductor__report_turn_status";

export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

export interface PlanStep {
  label: string;
  status: PlanStepStatus;
  detail?: string;
}

/** The latest write_plan call, as ChatRenderer.dashPlan records it. `at` is how
 *  many message rows existed when it was written, so every row at index `at` or
 *  later came after it. ChatRenderer.remapIndices keeps it aligned when older
 *  pages are prepended or a row is spliced out. */
export interface DashboardPlan {
  steps: PlanStep[];
  at: number;
}

export interface DashboardInput {
  messages: readonly RenderedMessage[];
  plan: DashboardPlan | null;
  /** A turn is running (or messages are held): the Plan card then draws even
   *  with no steps, because it hosts the chat's status line. */
  busy?: boolean;
  /** What the daemon remembers for the Answers card, once loaded. */
  answers?: AnswerSide;
}

/** Context every derive gets, computed once per derive pass. */
export interface DeriveCtx {
  input: DashboardInput;
  /** Index of Joe's latest own message, -1 when he has sent none. */
  lastJoe: number;
}

// ---- Row classifiers ---------------------------------------------------------

/** A send_message row the main agent wrote that draws: not refused, not
 *  retracted, not a sub's card shown in this main chat. */
export function isOwnMessage(m: RenderedMessage): boolean {
  return m.kind === "message" && !m.failed && !m.retracted && !m.subCard;
}

/** The card kind of an own message, "legacy" for one sent before kinds existed. */
export function messageKindOf(m: RenderedMessage): MessageKind | "legacy" {
  return m.card?.kind ?? "legacy";
}

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
 *  (chat-dashboard/answers-card.ts) decides which one shows. */
export function deriveAnswers({ input }: DeriveCtx): AnswersState | null {
  const items = buildAnswerItems(input.messages, input.answers);
  return items.length > 0 ? { items } : null;
}

export type WaitingItem =
  | { type: "blocker"; message: RenderedMessage }
  | { type: "do_this"; message: RenderedMessage }
  | { type: "question"; message: RenderedMessage; questions: string[] };

export interface WaitingState {
  items: WaitingItem[];
  /** Any blocker: the zone draws red instead of amber. */
  blocked: boolean;
}

function questionTexts(m: RenderedMessage): string[] {
  const raw = (m.input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => (q && typeof q === "object" && typeof (q as { question?: unknown }).question === "string"
    ? [(q as { question: string }).question] : []));
}

/** Blockers first (tinted red), then what only Joe can do, then open questions.
 *  A blocker or do_this counts only until Joe writes again, since his next
 *  message is how he answers it. A sub's blocker counts until that sub sends a
 *  later card. Open question cards count until they are answered. */
export function deriveWaiting({ input, lastJoe }: DeriveCtx): WaitingState | null {
  const msgs = input.messages;
  const blockers: WaitingItem[] = [];
  const doThis: WaitingItem[] = [];
  const questions: WaitingItem[] = [];
  msgs.forEach((m, i) => {
    if (isOwnMessage(m) && i > lastJoe) {
      const k = messageKindOf(m);
      if (k === "blocker") blockers.push({ type: "blocker", message: m });
      else if (k === "do_this") doThis.push({ type: "do_this", message: m });
    } else if (m.kind === "message" && m.subCard?.kind === "blocker" && !m.failed && !m.retracted) {
      const sub = m.subCard.sub_id;
      const later = !!sub && msgs.some((n, j) => j > i && n.subCard?.sub_id === sub);
      if (!later) blockers.push({ type: "blocker", message: m });
    } else if (isOpenQuestion(m)) {
      questions.push({ type: "question", message: m, questions: questionTexts(m) });
    }
  });
  const items = [...blockers, ...doThis, ...questions];
  return items.length > 0 ? { items, blocked: blockers.length > 0 } : null;
}

export interface PlanState {
  steps: PlanStep[];
  /** Steps finished (done or skipped). */
  done: number;
  /** The latest `plan`-kind message of this job: its text leads the card. */
  lead: RenderedMessage | null;
  /** The finished job's report. When set, the Result takes the Plan card's spot. */
  result: RenderedMessage | null;
}

/** The job's report once the job has ended: the latest report Joe has not
 *  written past, provided the turn that sent it closed. A chat that never calls
 *  report_turn_status (an old or external one) has no closing signal, so its
 *  report counts as final. */
function finishedReport(msgs: readonly RenderedMessage[], lastJoe: number): number {
  const r = lastIndexWhere(msgs, (m) => isOwnMessage(m) && messageKindOf(m) === "report");
  if (r < 0 || r < lastJoe) return -1;
  const anyStatus = msgs.some((m) => turnStatusOf(m) !== null);
  if (!anyStatus) return r;
  for (let i = r + 1; i < msgs.length; i++) {
    const s = turnStatusOf(msgs[i]!);
    if (s !== null && s !== "working") return r;
  }
  return -1;
}

/** A plan belongs to the current job unless that job already ended: a report
 *  sent after the plan and before Joe's latest message means he has moved on. */
function planIsCurrent(msgs: readonly RenderedMessage[], plan: DashboardPlan, lastJoe: number): boolean {
  if (lastJoe < plan.at) return true;
  for (let i = plan.at; i < lastJoe; i++) {
    const m = msgs[i]!;
    if (isOwnMessage(m) && messageKindOf(m) === "report") return false;
  }
  return true;
}

export function derivePlan({ input, lastJoe }: DeriveCtx): PlanState | null {
  const msgs = input.messages;
  const plan = input.plan && planIsCurrent(msgs, input.plan, lastJoe) ? input.plan : null;
  const steps = plan?.steps ?? [];
  const resultAt = finishedReport(msgs, lastJoe);
  // The lead is this job's: after the Joe message that started it, which is the
  // one before the plan when there is a plan (later ones answered its questions).
  const leadFrom = plan ? lastIndexWhere(msgs, isJoeMessage, Math.min(plan.at, msgs.length) - 1) : lastJoe;
  const leadAt = lastIndexWhere(msgs, (m, i) => i > leadFrom && isOwnMessage(m) && messageKindOf(m) === "plan");
  const result = resultAt >= 0 ? msgs[resultAt]! : null;
  const lead = leadAt >= 0 ? msgs[leadAt]! : null;
  if (steps.length === 0 && !result && !lead && !input.busy) return null;
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { steps, done, lead, result };
}

export interface CardListState {
  cards: RenderedMessage[];
}

const SUBCHAT_CARDS_SHOWN = 4;

/** Placeholder for lane `dash-subchats`: the newest card of each sub (finished
 *  reports, all-finished notes), newest first. A sub's blocker shows in Waiting
 *  on you instead. */
export function deriveSubchats({ input }: DeriveCtx): CardListState | null {
  const seen = new Set<string>();
  const cards: RenderedMessage[] = [];
  for (let i = input.messages.length - 1; i >= 0 && cards.length < SUBCHAT_CARDS_SHOWN; i--) {
    const m = input.messages[i]!;
    if (m.kind !== "message" || !m.subCard || m.failed || m.retracted) continue;
    const key = m.subCard.sub_id || m.subCard.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.subCard.kind !== "blocker") cards.push(m);
  }
  return cards.length > 0 ? { cards } : null;
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

const LINKS_SHOWN = 5;

/** Placeholder for lane `dash-extras`: the newest artifact messages (a file,
 *  preview or link to open), newest first. */
export function deriveLinks({ input }: DeriveCtx): CardListState | null {
  const cards = input.messages.filter((m) => isOwnMessage(m) && messageKindOf(m) === "artifact").slice(-LINKS_SHOWN).reverse();
  return cards.length > 0 ? { cards } : null;
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
  plan: zone({ column: "right", order: 10, derive: derivePlan }),
  subchats: zone({ column: "right", order: 20, derive: deriveSubchats }),
  notes: zone({ column: "right", order: 30, derive: deriveNotes }),
  links: zone({ column: "right", order: 40, derive: deriveLinks }),
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
