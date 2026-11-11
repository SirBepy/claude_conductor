// The Answers card's data (docs/chat-dashboard-design.md, "Answers" and
// "Answers card"). Pure, like dashboard-model.ts: it turns the chat's
// send_message answers, plus what the daemon remembers for the card
// (daemon/methods/answers.rs: read marks, thread links, + questions) and the
// Ask threads behind them, into one list the card walks.

import type { RenderedMessage } from "../chat-classifiers";
import type { AskThread } from "../../../types/ipc.generated";
import { stripAuqAnswerBlock, stripAuqExtraBlock } from "../chat-event-to-message";
import { blocksToText } from "../content-blocks";
import { bodyOf, headlineOf } from "../chat-message-kinds";
import { SUBCHAT_TOOL } from "../chat-subchat-passed";
import type { SubCardEntry } from "../subchat-cards";
import type { SubCardItem } from "./subs-model";

/** What `answers_state` returns: daemon/ask/answer_state.rs's AnswerState. */
export interface AnswerStore {
  /** Answer key -> when Joe pressed Got it (ms). */
  read: Record<string, number>;
  /** Answer key -> the Ask thread holding its follow-ups. */
  threads: Record<string, string>;
  /** Questions Joe started with +, oldest first. */
  questions: { thread_id: string; asked_at: number }[];
  /** Answer key -> the short question the daemon had a model write for an answer
   *  whose send_message carried none (daemon/methods/answers.rs). */
  rewrites: Record<string, string>;
}

export function emptyStore(): AnswerStore {
  return { read: {}, threads: {}, questions: [], rewrites: {} };
}

/** Everything the card reads besides the transcript. */
export interface AnswerSide {
  store: AnswerStore;
  threads: readonly AskThread[];
}

export interface AnswerItem {
  /** The send_message tool_use id, or `ask:<thread id>` for a + question's reply. */
  key: string;
  /** The row the card draws: the transcript's own, or one built from a + question's reply. */
  message: RenderedMessage;
  /** The question as the card shows it: Claude's rewrite, else the daemon's stored
   *  one, else a clipped preview of what Joe typed. */
  question: string;
  /** What Joe typed, shown on hover in the thread when `question` is not his own words. */
  raw: string | null;
  /** The whole message this answer replies to, for the daemon's rewrite call. */
  typed: string;
  /** `question` is only a clipped preview of a long `typed`: no rewrite exists yet. */
  provisional: boolean;
  /** When it was answered (ms). */
  at: number;
  verdict: string;
  /** The answer's own text, the thread's opening reply. */
  text: string;
  thread: AskThread | null;
  /** Joe's follow-ups in the thread. A + question's own first message is not one. */
  replies: number;
  /** Came from a + question, not from the chat. */
  asked: boolean;
  /** When the chat judged from Joe's next message that he read it (ms), 0 = never. */
  seenAt: number;
  /** Set on a question handed to a sub that has no answer yet: the row the card
   *  shows at once, before the sub reports. Null on every answer. */
  pending: Handoff | null;
  /** On an answer that filled a handed-off question's row: that row's key, so
   *  the card turns the same row into the answer instead of drawing a second one. */
  handoff: string | null;
}

/** Where a handed-off question stands. The first five wait on the sub, so the
 *  row stays until its answer fills it. The sub is done with the last four:
 *  the answer is on its way or will not come, and Got it puts the row away, so a
 *  main chat that never sends the answer cannot leave a row Joe cannot clear. */
export type HandoffState =
  | "sending" | "checking" | "queued" | "asking" | "blocked"
  | "writing" | "failed" | "ended" | "refused";

const LIVE_STATES: ReadonlySet<HandoffState> = new Set(["sending", "checking", "queued", "asking", "blocked"]);

export interface Handoff {
  /** The spawn_chat tool_use id. */
  spawnId: string;
  /** From the spawn's result; null until it lands or when it was refused. */
  subId: string | null;
  subName: string;
  state: HandoffState;
  /** The line under the question: "Checking... (release-q)". */
  line: string;
  /** What the sub or the daemon said, for a row that will not get an answer. */
  note: string;
}

export const SPAWN_CHAT_TOOL = "mcp__cc_conductor__spawn_chat";
const HANDOFF_PREFIX = "handoff:";

/** Still on its way: the card shows it but there is nothing to mark read yet. */
export function isLivePending(item: AnswerItem): boolean {
  return !!item.pending && LIVE_STATES.has(item.pending.state);
}

const PASTED_LOG_RE = /<pasted-log(?: id="[^"]*")? name="([^"]*)">[\s\S]*?<\/pasted-log(?::[^>]*)?>/g;
const FILE_TOKEN_RE = /<file:(.+?)(?:::(.+?))?>/g;

/** One plain line of a message Joe typed: chips become their names. */
export function plainUserText(m: RenderedMessage): string {
  const blocks = stripAuqExtraBlock(stripAuqAnswerBlock(m.content ?? []));
  const text = blocksToText(blocks)
    .replace(PASTED_LOG_RE, (_all, name: string) => `[${name || "pasted log"}]`)
    .replace(FILE_TOKEN_RE, (_all, path: string, name?: string) => name ?? path.split(/[\\/]/).pop() ?? path)
    .replace(/<voice-input\s*\/>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return text;
  return blocks.some((b) => b.type === "image") ? "(image)" : "";
}

/** A transcript row's ts may be in seconds (older events) or ms. */
export const toMs = (ts: number | bigint | undefined | null): number => {
  const n = Number(ts ?? 0);
  return n > 0 && n < 1e10 ? n * 1000 : n;
};
/** An Ask thread's and the answer store's times are always ms (daemon now_ms). */
const askMs = (ts: number | bigint | undefined | null): number => Number(ts ?? 0);

/** The reply to a + question, split into the two lines the sidecar was asked
 *  to open with (daemon/methods/answers.rs NEW_QUESTION_CONTEXT) and the rest. */
export function parseQuestionReply(reply: string): { question: string | null; verdict: string | null; body: string } {
  const lines = reply.replace(/\r\n/g, "\n").split("\n");
  let question: string | null = null;
  let verdict: string | null = null;
  let i = 0;
  for (; i < lines.length && i < 4; i++) {
    const l = lines[i]!.trim().replace(/^\*\*|\*\*$/g, "");
    const q = /^QUESTION:\s*(.+)$/i.exec(l);
    const v = /^VERDICT:\s*(.+)$/i.exec(l);
    if (q && question === null) question = q[1]!.trim();
    else if (v && verdict === null) verdict = v[1]!.trim();
    else if (l !== "") break;
  }
  return { question, verdict, body: lines.slice(i).join("\n").trim() };
}

/** How much of Joe's own message stands in for a question until a short one is
 *  written. His whole message can be a page long and name several things. */
export const PREVIEW_MAX = 90;

/** The start of his message, cut at a word and marked, never the whole wall of text. */
export function clipPreview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= PREVIEW_MAX) return t;
  const cut = t.slice(0, PREVIEW_MAX);
  const at = cut.lastIndexOf(" ");
  return `${(at > PREVIEW_MAX / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "")}\u2026`;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Threads written before 2026-11-10 may end in a `SUGGESTED:` line, the hand-off
 *  the removed Ask panel turned into a draft; the card has no use for it. */
export function withoutSuggestion(text: string): string {
  return text.replace(/\n\s*[>\-*\s]*SUGGESTED:[^\n]*\s*$/, "").trimEnd();
}

/** Which answers count: only replies to Joe's questions, never a request's
 *  plan or report (docs: "Answer to you should only answer to answers"). A
 *  rating is a judgement he asked for, so it is one too. */
export function isAnswerRow(m: RenderedMessage): boolean {
  return m.kind === "message" && !m.failed && !m.retracted && !m.subCard
    && (m.card?.kind === "answer" || m.card?.kind === "rating");
}

function isJoeRow(m: RenderedMessage): boolean {
  return m.kind === "user" && !m.authorSessionId && plainUserText(m) !== "";
}

function threadById(side: AnswerSide | undefined, id: string | undefined): AskThread | null {
  if (!id || !side) return null;
  return side.threads.find((t) => t.id === id) ?? null;
}

const userCount = (t: AskThread | null): number => t?.messages.filter((m) => m.role === "user").length ?? 0;

const normVerdict = (v: string): string => v.trim().replace(/\s+/g, " ").toLowerCase();

/** A message's `read_answers` (the chat's judgement of Joe's latest message)
 *  marks the newest earlier answer with each verdict, among those he could have
 *  read: answers that landed before his latest message. */
function applyReadJudgement(m: RenderedMessage, chat: readonly { item: AnswerItem; joeBefore: number }[], joeCount: number): void {
  const read = m.card?.readAnswers;
  if (!read?.length || m.failed || m.retracted || m.subCard || joeCount === 0) return;
  // A row with no time still counts as read; 0 would mean "never judged".
  const at = toMs(m.ts) || 1;
  for (const v of read) {
    const want = normVerdict(v);
    for (let i = chat.length - 1; i >= 0; i--) {
      const c = chat[i]!;
      if (c.joeBefore >= joeCount || normVerdict(c.item.verdict) !== want) continue;
      c.item.seenAt = Math.max(c.item.seenAt, at);
      break;
    }
  }
}

/** A question the main chat handed to a sub (SUBCHATS_MAIN_PROMPT rule 11), as
 *  the transcript shows it: the spawn_chat call, its result, the sub's cards. */
interface SpawnAsk {
  spawnId: string;
  /** The question as the row shows it (clipped past 200 chars). */
  task: string;
  /** The whole task, for matching the answer's own question. */
  fullTask: string;
  subName: string;
  at: number;
  /** Joe's message the question came from. */
  typed: string;
  /** Joe messages before the spawn, so a refused spawn retried in the same turn draws once. */
  joeCount: number;
  resultSeen: boolean;
  subId: string | null;
  refused: string | null;
  finish: SubCardEntry | null;
  blocker: SubCardEntry | null;
  answered: boolean;
  /** Its turn ended before a result came; a late answer may still name it. */
  cut: boolean;
  /** Joe messages seen when the sub's finish card landed: an answer before his
   *  next message is the main chat's report on that sub. */
  finishJoe: number;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** Case, spacing and punctuation never decide whether two questions are the same one. */
const sameWords = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Only words that never open an instruction: "Can you", "Have a look", "Do an audit" are jobs without their mark.
const QUESTION_START = /^(why|what|how|which|who|whose|where|when|is|are|was|were|does|did)\b/i;

/** Rule 11's hand-off is the one spawn_chat that is read-only and reports back:
 *  a job that writes, a gate or a respawn is never a question. Read off the call
 *  itself, so no step the main chat has to remember decides whether the row shows. */
function handoffOf(m: RenderedMessage): { task: string; full: string; name: string } | null {
  if (m.kind !== "tool_use" || m.tool !== SPAWN_CHAT_TOOL || m.parentToolUseId || !m.id) return null;
  const i = asRecord(m.input);
  if (i.report_back !== true || i.writes === true || i.gate === true || i.respawn === true) return null;
  const task = str(i.task).replace(/\s+/g, " ").trim();
  // Rule 11 hands off "one clear question"; a read-only research job the main
  // chat runs for its own next step ("Find where X lives") reports back too, but
  // it is not Joe's question. A question that lost its mark still starts like one.
  if (!task.endsWith("?") && !QUESTION_START.test(task)) return null;
  return { task: task.length > 200 ? clipPreview(task) : task, full: task, name: str(i.name).trim() };
}

/** The spawn's result: the sub's id, or why the daemon refused it. */
function readSpawnResult(ask: SpawnAsk, m: RenderedMessage): void {
  ask.resultSeen = true;
  // A result that lands after its turn was judged cut off still wins.
  ask.refused = null;
  ask.cut = false;
  const text = m.output?.type === "text" ? m.output.text : "";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = asRecord(JSON.parse(text));
  } catch { /* a plain-text result: an error, or a shape this card does not know */ }
  if (m.is_error || parsed.ok === false) {
    ask.refused = str(parsed.error) || text.trim() || "The daemon refused it.";
    return;
  }
  ask.subId = str(parsed.session_id) || null;
}

const TURN_STATUS = "mcp__cc_conductor__report_turn_status";

function cutOff(ask: SpawnAsk): void {
  ask.resultSeen = true;
  ask.refused = "The turn ended before the daemon answered the hand-off.";
  ask.cut = true;
}

const subLabel = (ask: SpawnAsk, sub: SubCardItem | undefined): string => ask.subName || sub?.name || "a sub";

/** A sub this new may not be on the instance list yet, so its absence says nothing. */
const GONE_GRACE_MS = 30_000;

/** `gone`: the instance list is known and no longer holds the sub, which is how
 *  a dropped, closed or crashed sub looks there (the list keeps only live rows). */
function handoffNow(ask: SpawnAsk, sub: SubCardItem | undefined, gone: boolean): Pick<Handoff, "state" | "line" | "note"> {
  const name = subLabel(ask, sub);
  if (ask.refused !== null) return { state: "refused", line: "Not handed off: the sub did not start", note: ask.refused };
  if (!ask.resultSeen) return { state: "sending", line: `Handing it to ${name}...`, note: "" };
  if (ask.finish) {
    const said = [ask.finish.verdict, ask.finish.text].filter(Boolean).join(": ");
    return ask.finish.tone === "bad"
      ? { state: "failed", line: `${name} could not answer`, note: said }
      : { state: "writing", line: `${name} finished, the answer is on its way`, note: said };
  }
  if (gone) return { state: "ended", line: `${name} ended without an answer`, note: "It was dropped or closed before it finished." };
  // A closing sub also reads "finished" on the list; only a real finish means the answer is coming.
  if (sub?.kind === "finished" && !sub.closing) return { state: "writing", line: `${name} finished, the answer is on its way`, note: "" };
  if (ask.blocker) return { state: "blocked", line: `${name} is stuck: ${ask.blocker.verdict}`, note: ask.blocker.text };
  if (sub?.kind === "asking") return { state: "asking", line: `${name} is asking you something`, note: "" };
  if (sub?.kind === "queued") return { state: "queued", line: `Queued (${name})`, note: sub.progress };
  return { state: "checking", line: `Checking... (${name})`, note: "" };
}

/** Which open hand-off an answer fills: the one whose question it repeats, else
 *  the sub the main chat just read with `subchat status` (rule 11's step before
 *  the answer), else, for an answer that names no question of its own, the oldest
 *  one whose sub has already finished. An answer whose own question matches no
 *  hand-off and follows no status call was about something else. */
function handoffFor(m: RenderedMessage, open: readonly SpawnAsk[], statusOf: string | null, joeCount: number): SpawnAsk | null {
  const waiting = open.filter((a) => !a.answered && (a.refused === null || a.cut));
  const q = sameWords(m.card?.question ?? "");
  if (q) {
    const same = waiting.find((a) => sameWords(a.fullTask) === q);
    if (same) return same;
  }
  if (statusOf) {
    const s = sameWords(statusOf);
    const id = statusOf.trim();
    // An id prefix counts only when it is long enough to name one sub.
    const named = waiting.filter((a) => (a.subName && sameWords(a.subName) === s) || (id.length >= 8 && a.subId?.startsWith(id)));
    if (named.length) return named[named.length - 1]!;
  }
  // Worded differently and no status call: still the report on a sub that
  // finished since Joe last wrote, the wake turn report_back starts.
  if (q) return waiting.find((a) => a.finish !== null && a.finishJoe === joeCount) ?? null;
  return waiting.find((a) => a.finish !== null) ?? null;
}

/** Every answer, oldest first, with each handed-off question that has no answer
 *  yet as its own row. `subs` is this chat's subs off the instance list, left
 *  out while that list does not hold this chat yet (nothing can be called gone). */
export function buildAnswerItems(
  messages: readonly RenderedMessage[], side?: AnswerSide, subs?: readonly SubCardItem[], now: number = Date.now(),
): AnswerItem[] {
  const items: AnswerItem[] = [];
  const chat: { item: AnswerItem; joeBefore: number }[] = [];
  const asks: SpawnAsk[] = [];
  const asksById = new Map<string, SpawnAsk>();
  let joe: RenderedMessage | null = null;
  let joeCount = 0;
  let statusOf: string | null = null;
  const turnEnds = new Set<string>();
  for (const m of messages) {
    if (isJoeRow(m)) {
      joe = m;
      joeCount++;
      statusOf = null;
    }
    if (m.kind === "tool_use" && m.tool === TURN_STATUS && !m.parentToolUseId && m.id) turnEnds.add(m.id);
    // A turn that ended (or a new one Joe started) before a spawn's result came
    // was cut off: that hand-off will never get a sub, so it must not wait forever.
    // The turn's end is its status call's result, not the call: calls made in one
    // message all come before any of their results.
    if (isJoeRow(m) || (m.kind === "tool_result" && m.tool_use_id && turnEnds.has(m.tool_use_id))) {
      for (const a of asks) if (!a.resultSeen) cutOff(a);
    }
    const spawn = handoffOf(m);
    if (spawn) {
      const ask: SpawnAsk = {
        spawnId: m.id!, task: spawn.task, fullTask: spawn.full, subName: spawn.name, at: toMs(m.ts), typed: joe ? plainUserText(joe) : "",
        joeCount, resultSeen: false, subId: null, refused: null, finish: null, blocker: null, answered: false, cut: false, finishJoe: -1,
      };
      asks.push(ask);
      asksById.set(ask.spawnId, ask);
      continue;
    }
    if (m.kind === "tool_result" && m.tool_use_id) {
      const ask = asksById.get(m.tool_use_id);
      if (ask) readSpawnResult(ask, m);
      continue;
    }
    if (m.kind === "tool_use" && m.tool === SUBCHAT_TOOL && !m.parentToolUseId) {
      const i = asRecord(m.input);
      if (i.action === "status" && str(i.sub).trim()) statusOf = str(i.sub);
      continue;
    }
    const card = m.subCard;
    if (card?.sub_id && (card.kind === "finish" || card.kind === "blocker")) {
      for (const a of asks) {
        if (a.subId !== card.sub_id) continue;
        if (card.kind === "finish") {
          a.finish = card;
          a.finishJoe = joeCount;
        }
        else a.blocker = card;
      }
    }
    if (m.kind === "message") applyReadJudgement(m, chat, joeCount);
    if (!isAnswerRow(m) || !m.id) continue;
    const ask = handoffFor(m, asks, statusOf, joeCount);
    if (ask) ask.answered = true;
    statusOf = null;
    // A handed-off question's answer belongs to the message Joe asked it in, not to whatever he typed since.
    const typed = ask ? ask.typed : joe ? plainUserText(joe) : "";
    const rewrite = m.card?.question ?? side?.store.rewrites[m.id] ?? ask?.task ?? null;
    const question = rewrite ?? clipPreview(typed);
    // A message that fits the preview is already its own question; only a clipped one wants a rewrite.
    const provisional = !rewrite && question !== typed;
    const thread = threadById(side, side?.store.threads[m.id]);
    const item: AnswerItem = {
      key: m.id,
      message: m,
      question,
      raw: typed && question !== typed ? typed : null,
      typed,
      provisional,
      at: toMs(m.ts),
      verdict: m.card?.verdict ?? "",
      text: m.text ?? "",
      thread,
      replies: userCount(thread),
      asked: false,
      seenAt: 0,
      pending: null,
      handoff: ask ? HANDOFF_PREFIX + ask.spawnId : null,
    };
    items.push(item);
    chat.push({ item, joeBefore: joeCount });
  }
  const subById = new Map((subs ?? []).map((s) => [s.id, s]));
  for (const ask of asks) {
    if (ask.answered) continue;
    // A refused spawn the main chat tried again in the same turn is that retry's row.
    // A refused spawn for a question another spawn of the same turn carries (a
    // retry, or a duplicate of one already running) is that other row.
    if (ask.refused !== null && asks.some((b) => b !== ask && (b.refused === null || asks.indexOf(b) > asks.indexOf(ask)) && b.joeCount === ask.joeCount
      && (sameWords(b.fullTask) === sameWords(ask.fullTask) || (!!ask.subName && b.subName === ask.subName && asks.indexOf(b) > asks.indexOf(ask))))) continue;
    const sub = ask.subId ? subById.get(ask.subId) : undefined;
    const gone = !!subs && !!ask.subId && !sub && ask.at > 0 && now - ask.at > GONE_GRACE_MS;
    const state = handoffNow(ask, sub, gone);
    const key = HANDOFF_PREFIX + ask.spawnId;
    items.push({
      key,
      message: { kind: "message", id: key, text: state.note, ts: ask.at, parentToolUseId: null, card: { kind: "answer", verdict: state.line } } as RenderedMessage,
      question: ask.task,
      raw: ask.typed && ask.typed !== ask.task ? ask.typed : null,
      typed: ask.typed,
      provisional: false,
      at: ask.at,
      verdict: state.line,
      text: state.note,
      thread: null,
      replies: 0,
      asked: false,
      seenAt: 0,
      pending: { spawnId: ask.spawnId, subId: ask.subId, subName: subLabel(ask, sub), ...state },
      handoff: null,
    });
  }
  for (const q of side?.store.questions ?? []) {
    const thread = threadById(side, q.thread_id);
    const first = thread?.messages[0];
    const reply = thread?.messages[1];
    // No reply yet: the + thread is still open on its first question, not an answer.
    if (!thread || first?.role !== "user" || reply?.role !== "assistant") continue;
    const parsed = parseQuestionReply(withoutSuggestion(reply.text));
    const body = parsed.body || reply.text.trim();
    const verdict = parsed.verdict ?? headlineOf(body);
    const text = parsed.verdict ? body : bodyOf(body) || body;
    const key = `ask:${thread.id}`;
    const question = parsed.question ?? capitalise(first.text.trim());
    items.push({
      key,
      message: {
        kind: "message", id: key, text, ts: askMs(reply.ts), parentToolUseId: null,
        card: { kind: "answer", verdict },
      } as RenderedMessage,
      question,
      raw: question !== first.text.trim() ? first.text.trim() : null,
      typed: first.text.trim(),
      provisional: false,
      at: askMs(reply.ts) || askMs(q.asked_at),
      verdict,
      text,
      thread,
      replies: Math.max(0, userCount(thread) - 1),
      asked: true,
      seenAt: 0,
      pending: null,
      handoff: null,
    });
  }
  return items.sort((a, b) => a.at - b.at);
}

/** The thread's messages after the opening pair the card draws from the answer
 *  itself: all of them for a chat answer, all but the first two for a + question. */
export function threadFollowUps(item: AnswerItem): AskThread["messages"] {
  const msgs = item.thread?.messages ?? [];
  return item.asked ? msgs.slice(2) : msgs;
}

/** Unread until Got it or until the chat judged Joe's next message shows he read
 *  it, and unread again when its thread got a reply after that. */
export function isUnread(item: AnswerItem, store: AnswerStore): boolean {
  if (isLivePending(item)) return false;
  const readAt = Math.max(store.read[item.key] ?? 0, item.seenAt);
  if (readAt <= 0) return true;
  const replies = threadFollowUps(item).filter((m) => m.role === "assistant");
  return replies.some((m) => askMs(m.ts) > readAt);
}

/** The answer the card shows next: the newest unread, or null for All caught up. */
export function nextUnread(items: readonly AnswerItem[], store: AnswerStore, skip?: string): AnswerItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.key !== skip && isUnread(it, store)) return it;
  }
  return null;
}

/** What the card shows when no unread answer is left: the newest question still
 *  being checked, so a hand-off never hides behind All caught up. */
export function nextWaiting(items: readonly AnswerItem[], store: AnswerStore, skip?: string): AnswerItem | null {
  const unread = nextUnread(items, store, skip);
  if (unread) return unread;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.key !== skip && isLivePending(it)) return it;
  }
  return null;
}

/** Unread answers and questions still being checked, the ones a pending row's Next walks through. */
export function isWaiting(item: AnswerItem, store: AnswerStore): boolean {
  return isLivePending(item) || isUnread(item, store);
}

export type HistoryGroupId = "pending" | "unread" | "threaded" | "read";

export interface HistoryGroup {
  id: HistoryGroupId;
  label: string;
  items: AnswerItem[];
}

const GROUP_LABEL: Record<HistoryGroupId, string> = {
  pending: "Being checked",
  unread: "Unread",
  threaded: "Read, with a thread",
  read: "Read",
};

/** History's list: Being checked, Unread, then Read with a thread, then Read,
 *  newest first in each. Empty groups are dropped; a heading shows only with two
 *  groups or more. */
export function historyGroups(items: readonly AnswerItem[], store: AnswerStore): { groups: HistoryGroup[]; headings: boolean } {
  const newest = [...items].reverse();
  const by: Record<HistoryGroupId, AnswerItem[]> = { pending: [], unread: [], threaded: [], read: [] };
  for (const it of newest) {
    if (isLivePending(it)) by.pending.push(it);
    else if (isUnread(it, store)) by.unread.push(it);
    else if (it.replies > 0) by.threaded.push(it);
    else by.read.push(it);
  }
  const groups = (["pending", "unread", "threaded", "read"] as const)
    .filter((id) => by[id].length > 0)
    .map((id) => ({ id, label: GROUP_LABEL[id], items: by[id] }));
  return { groups, headings: groups.length >= 2 };
}

/** Everything a thread said, for History's search. */
export function threadText(item: AnswerItem): string {
  return threadFollowUps(item).map((m) => m.text).join("\n");
}

/** What a row matches on without its thread: the question, Joe's words, the verdict and the answer. */
export function ownText(item: AnswerItem): string {
  return `${item.question} ${item.raw ?? ""} ${item.verdict} ${item.text}`;
}
