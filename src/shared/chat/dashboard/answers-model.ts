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

/** What `answers_state` returns: daemon/ask/answer_state.rs's AnswerState. */
export interface AnswerStore {
  /** Answer key -> when Joe pressed Got it (ms). */
  read: Record<string, number>;
  /** Answer key -> the Ask thread holding its follow-ups. */
  threads: Record<string, string>;
  /** Questions Joe started with +, oldest first. */
  questions: { thread_id: string; asked_at: number }[];
}

export function emptyStore(): AnswerStore {
  return { read: {}, threads: {}, questions: [] };
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
  /** The question as the card shows it: Claude's rewrite, else what Joe typed. */
  question: string;
  /** What Joe typed, shown on hover in the thread when `question` is a rewrite. */
  raw: string | null;
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

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Ask's optional trailing `SUGGESTED:` line is the Ask panel's hand-off; the card has none. */
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

/** Every answer, oldest first. */
export function buildAnswerItems(messages: readonly RenderedMessage[], side?: AnswerSide): AnswerItem[] {
  const items: AnswerItem[] = [];
  let joe: RenderedMessage | null = null;
  for (const m of messages) {
    if (isJoeRow(m)) joe = m;
    if (!isAnswerRow(m) || !m.id) continue;
    const typed = joe ? plainUserText(joe) : "";
    const rewrite = m.card?.question ?? null;
    const thread = threadById(side, side?.store.threads[m.id]);
    items.push({
      key: m.id,
      message: m,
      question: rewrite ?? typed,
      raw: rewrite && typed && rewrite !== typed ? typed : null,
      at: toMs(m.ts),
      verdict: m.card?.verdict ?? "",
      text: m.text ?? "",
      thread,
      replies: userCount(thread),
      asked: false,
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
      at: askMs(reply.ts) || askMs(q.asked_at),
      verdict,
      text,
      thread,
      replies: Math.max(0, userCount(thread) - 1),
      asked: true,
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

/** Unread until Got it, and unread again when its thread got a reply after that. */
export function isUnread(item: AnswerItem, store: AnswerStore): boolean {
  const readAt = store.read[item.key];
  if (readAt === undefined) return true;
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

export type HistoryGroupId = "unread" | "threaded" | "read";

export interface HistoryGroup {
  id: HistoryGroupId;
  label: string;
  items: AnswerItem[];
}

const GROUP_LABEL: Record<HistoryGroupId, string> = {
  unread: "Unread",
  threaded: "Read, with a thread",
  read: "Read",
};

/** History's list: Unread, then Read with a thread, then Read, newest first in
 *  each. Empty groups are dropped; a heading shows only with two groups or more. */
export function historyGroups(items: readonly AnswerItem[], store: AnswerStore): { groups: HistoryGroup[]; headings: boolean } {
  const newest = [...items].reverse();
  const by: Record<HistoryGroupId, AnswerItem[]> = { unread: [], threaded: [], read: [] };
  for (const it of newest) {
    if (isUnread(it, store)) by.unread.push(it);
    else if (it.replies > 0) by.threaded.push(it);
    else by.read.push(it);
  }
  const groups = (["unread", "threaded", "read"] as const)
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
