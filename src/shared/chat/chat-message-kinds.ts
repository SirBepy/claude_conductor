// What kind of message a send_message call is (`kind`, `verdict`, report rows,
// ...). Like `details` and `next_actions`, the daemon route only validates the
// fields; the chat reads them straight off the tool_use input in the
// transcript, so live, reload, older pages and the phone all see them. Kept free
// of renderer imports so the event mappers can use it without a cycle through
// chat-transforms.

import { parseVisuals, type Visual } from "./message-visuals";

export const MESSAGE_KINDS = [
  "answer", "report", "blocker", "do_this", "plan", "rating",
  "correction", "call", "handoff", "artifact", "discovery", "ack",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MESSAGE_TONES = ["good", "bad", "neutral"] as const;
export type MessageTone = (typeof MESSAGE_TONES)[number];

/** Kinds whose conclusion is not worth a big word: the daemon rejects a verdict
 *  on these, and the model may not honour that, so a stray one is dropped here. */
const NO_VERDICT: ReadonlySet<MessageKind> = new Set(["plan", "handoff", "artifact", "ack"]);

export interface MessageCard {
  kind: MessageKind;
  verdict?: string;
  tone?: MessageTone;
  /** Extra points behind a click; on a rating, the ways to raise the score, drawn open as rows. */
  points?: string[];
  /** Report rows. */
  done?: string[];
  notDone?: string[];
  waitingOn?: string[];
  yourMove?: string[];
  /** Correction only: the earlier claim, drawn struck through. */
  was?: string;
  /** do_this only: a paste-ready payload. */
  copy?: string;
  /** answer only: Claude's clear rewrite of what Joe asked (the dashboard's Answers card). */
  question?: string;
  /** Any kind: verdicts of earlier answers Joe's latest message shows he read, as
   *  the chat judged it. The Answers card marks them read (answers-model.ts). */
  readAnswers?: string[];
  /** Tables and charts drawn under the body (message-visuals.ts). */
  visuals?: Visual[];
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** A malformed entry is dropped rather than failing the card, since the rest of
 *  it still reads. An empty list is `undefined`, never `[]`. */
function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(str).filter((s): s is string => s !== undefined);
  return out.length > 0 ? out : undefined;
}

/** Reads the kind fields off a send_message tool_use input. No valid `kind`
 *  means `undefined`, and the message then renders as the plain bubble it
 *  always was (old transcripts carry none). */
export function parseMessageCard(input: unknown): MessageCard | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const kind = (MESSAGE_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as MessageKind) : undefined;
  if (kind === undefined) return undefined;
  const card: MessageCard = { kind };
  if (!NO_VERDICT.has(kind)) card.verdict = str(raw.verdict);
  if ((MESSAGE_TONES as readonly unknown[]).includes(raw.tone)) card.tone = raw.tone as MessageTone;
  // Read before the ack return: the first message after Joe's is often a bare ack.
  const readAnswers = strList(raw.read_answers);
  if (readAnswers) card.readAnswers = readAnswers;
  if (kind === "ack") return card;
  card.points = strList(raw.points);
  const visuals = parseVisuals(raw);
  if (visuals?.length) card.visuals = visuals;
  if (kind === "report") {
    card.done = strList(raw.done);
    card.notDone = strList(raw.not_done);
    card.waitingOn = strList(raw.waiting_on);
    card.yourMove = strList(raw.your_move);
  }
  if (kind === "correction") card.was = str(raw.was);
  if (kind === "answer") {
    const q = str(raw.question);
    if (q !== undefined) card.question = q;
  }
  // The payload is pasted as written: trimming would eat a command's trailing newline.
  if (kind === "do_this" && typeof raw.copy === "string" && raw.copy.trim() !== "") card.copy = raw.copy;
  return card;
}

/** What an update_message call does to a card's visuals: `visuals` given replaces
 *  them (an empty list clears), absent keeps them, the same rule `details` follows. */
export function reviseCard(card: MessageCard | undefined, input: unknown): MessageCard | undefined {
  const visuals = parseVisuals(input);
  if (!card || visuals === undefined) return card;
  const { visuals: _old, ...rest } = card;
  return visuals.length > 0 ? { ...rest, visuals } : rest;
}

/** First line of a message's text: the one line a card prints large. */
export function headlineOf(text: string): string {
  const t = text.trim();
  const nl = t.indexOf("\n");
  return (nl < 0 ? t : t.slice(0, nl)).trim();
}

/** Everything after the headline, drawn muted. */
export function bodyOf(text: string): string {
  const t = text.trim();
  const nl = t.indexOf("\n");
  return nl < 0 ? "" : t.slice(nl + 1).trim();
}

/** How many rows of each open type a report carries. */
export function openCounts(card: MessageCard): { yours: number; notDone: number; waiting: number; total: number } {
  const yours = card.yourMove?.length ?? 0;
  const notDone = card.notDone?.length ?? 0;
  const waiting = card.waitingOn?.length ?? 0;
  return { yours, notDone, waiting, total: yours + notDone + waiting };
}

/** A message that draws a visible row: a card or a legacy bubble, but not an ack. */
export function isVisibleMessage(m: { kind: string; card?: MessageCard; failed?: boolean; retracted?: boolean; subCard?: unknown }): boolean {
  return m.kind === "message" && !m.failed && !m.retracted && !m.subCard && m.card?.kind !== "ack";
}
