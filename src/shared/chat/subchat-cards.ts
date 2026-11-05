// A main chat's sub cards: the verdict a finished sub drew, a `blocker` it sent,
// and the one "all finished" card. They are stored by the daemon per main chat
// (daemon/subchats/card_log.rs) because they live in no transcript, so this
// module reads them, turns each into a synthetic tool_use event and merges those
// into the chat's own events by timestamp. From there the normal event path
// (live, history load, older pages) renders them like any other message row.

import type { ChatEvent } from "../../types/ipc.generated";
import { invoke } from "../ipc";
import type { MessageCard } from "./chat-message-kinds";
import type { RenderedMessage } from "./chat-classifiers";

/** The `tool_name` of the synthetic event. Never a real tool, so nothing
 *  else in the chat reacts to it. */
export const SUBCARD_TOOL = "cc_subchat_card";

export interface SubTestFact { state: string; command?: string | null; summary?: string | null; stale?: boolean }
export interface SubReviewerFact { state: string; text?: string | null; note?: string | null }

/** Built by code from git and the sub's transcript, never from the sub's words.
 *  Every figure may be null: unknown shows as unknown. */
export interface SubFacts {
  since?: string;
  commits?: number | null;
  files_changed?: number | null;
  insertions?: number | null;
  deletions?: number | null;
  scoped?: boolean;
  uncommitted?: number | null;
  uncommitted_files?: string[];
  pushed?: boolean | null;
  test?: SubTestFact;
  reviewer?: SubReviewerFact;
  head?: string | null;
}

export interface SubSumFacts {
  subs: number;
  commits: number;
  files_changed: number;
  uncommitted: number;
  unpushed: number;
  tests_passed: number;
  tests_failed: number;
  tests_unknown: number;
  reviewed: number;
  unreviewed: number;
  unknown_subs: number;
}

export type SubCardKind = "finish" | "blocker" | "all_finished";

export interface SubCardEntry {
  id: string;
  /** Unix milliseconds. */
  ts: number;
  parent_id: string;
  kind: SubCardKind;
  sub_id?: string | null;
  sub_name?: string | null;
  round?: number | null;
  verdict: string;
  tone?: string | null;
  text: string;
  points?: string[];
  done?: string[];
  not_done?: string[];
  waiting_on?: string[];
  your_move?: string[];
  facts?: SubFacts | null;
  sum?: SubSumFacts | null;
  set_key?: string | null;
}

const KINDS: readonly string[] = ["finish", "blocker", "all_finished"];

/** Keeps the entries that can be drawn. A reply that is not a list (an older
 *  daemon, a failed call, a test double) is no cards. */
export function normalizeCards(raw: unknown): SubCardEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is SubCardEntry =>
      !!e && typeof e === "object" && typeof (e as SubCardEntry).id === "string"
      && typeof (e as SubCardEntry).ts === "number" && KINDS.includes((e as SubCardEntry).kind))
    .sort((a, b) => a.ts - b.ts);
}

/** Best-effort, like the other fetches a chat open makes: no cards is a chat
 *  without sub cards, not a broken load. */
export async function fetchSubCards(sessionId: string): Promise<SubCardEntry[]> {
  try {
    return normalizeCards(await invoke<unknown>("list_subchat_cards", { sessionId }));
  } catch {
    return [];
  }
}

export function subCardEvent(entry: SubCardEntry): ChatEvent {
  return { type: "tool_use", tool_name: SUBCARD_TOOL, input: entry, id: entry.id, timestamp: BigInt(0), parent_tool_use_id: null };
}

/** The card fields `renderMessageCard` draws from. A finish is a report (its
 *  rows become the done / not done chips); an "all finished" card has no rows
 *  and is told apart by `subCard.kind` when drawn. */
export function messageCardOf(e: SubCardEntry): MessageCard {
  if (e.kind === "blocker") return { kind: "blocker", verdict: e.verdict || undefined, tone: toneOf(e), points: e.points?.length ? e.points : undefined };
  const rows = (v?: string[]) => (v && v.length > 0 ? v : undefined);
  return {
    kind: "report",
    verdict: e.verdict || undefined,
    tone: toneOf(e),
    points: rows(e.points),
    done: rows(e.done),
    notDone: rows(e.not_done),
    waitingOn: rows(e.waiting_on),
    yourMove: rows(e.your_move),
  };
}

function toneOf(e: SubCardEntry): MessageCard["tone"] {
  return e.tone === "good" || e.tone === "bad" || e.tone === "neutral" ? e.tone : undefined;
}

/** Epoch milliseconds of an event: history events carry them, live ones carry 0. */
function eventMs(ev: ChatEvent): number {
  const raw = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : 0;
  if (!raw) return 0;
  return raw < 1e10 ? raw * 1000 : raw;
}

/** `events` (oldest first) with the cards of `pool` that fall inside it spliced
 *  in by timestamp. A card is placed once: `placed` records the ids, and a card
 *  already in it is skipped, so a page loaded twice or a card that arrived live
 *  never doubles.
 *
 *  `olderExists` is whether an older page is still unloaded. Then only cards
 *  from this page's first timestamp on belong here; the older ones wait for the
 *  page that holds their neighbours. A card newer than every event goes last. */
export function mergeSubCards(
  events: ChatEvent[],
  pool: readonly SubCardEntry[],
  placed: Set<string>,
  olderExists: boolean,
): ChatEvent[] {
  if (pool.length === 0) return events;
  const firstTs = events.map(eventMs).find((t) => t > 0);
  const lower = olderExists && firstTs ? firstTs : -Infinity;
  const waiting = pool.filter((c) => !placed.has(c.id) && c.ts >= lower);
  if (waiting.length === 0) return events;
  const out: ChatEvent[] = [];
  let next = 0;
  const flushUpTo = (limit: number) => {
    while (next < waiting.length && waiting[next]!.ts <= limit) {
      placed.add(waiting[next]!.id);
      out.push(subCardEvent(waiting[next]!));
      next++;
    }
  };
  for (const ev of events) {
    const t = eventMs(ev);
    // Only an event with its own time can be a landing spot: a tool_result or a
    // notification carries none, and splitting a call from its result is worse
    // than a card that lands one event late.
    if (t > 0) flushUpTo(t);
    out.push(ev);
  }
  flushUpTo(Infinity);
  return out;
}

/** The chat row for a synthetic card event, or `null` for an input that is not
 *  a card. The one place both the live handler and the older-page mapper build it. */
export function subCardRow(ev: { tool_name: string; input: unknown }): RenderedMessage | null {
  if (ev.tool_name !== SUBCARD_TOOL) return null;
  const [entry] = normalizeCards([ev.input]);
  if (!entry) return null;
  // No `id`: that field means "a tool_use in this transcript", and the resync
  // check compares those against the transcript's own, where a card is absent.
  return { kind: "message", text: entry.text ?? "", ts: entry.ts, parentToolUseId: null, card: messageCardOf(entry), subCard: entry };
}
