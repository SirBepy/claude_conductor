// Pure rules of the chat heads (docs/chat-heads-design.md): the order of the
// stack, the monogram that stands in for a project's face, which heads the
// keyboard walks, the red count. No DOM here, so tests/chat-heads-model.test.mjs
// drives every rule directly.

import type { Instance } from "../../types/ipc.generated";
import { STALE_MS } from "./drafts-grouping";
import { isSubchatsOn } from "./permission-modal/gating";
import { listedAsProjectMain } from "./project-main-chats";

export { monogramText, monogramHue, monogramStyle } from "../../shared/monogram";

/** A project's main chat: the stack draws it as the project's face and the chat header
 *  shows only the project name, so both ask here and never disagree. */
export function isProjectMainChat(s: Instance, sessions: readonly Instance[]): boolean {
  return !s.subchat_of && isSubchatsOn(s.session_id) && listedAsProjectMain(s, sessions);
}

/** settings.json extra-map key holding Joe's manual head order (ids, in order).
 *  The settings file is shared by every client of the daemon, so the desktop
 *  windows and the phone agree on the order and it survives a restart. */
export const HEAD_ORDER_KEY = "chatHeadsOrder";

/** The ids kept: the file only ever grows by what Joe drags, and an id outlives its chat. */
const MAX_ORDER_IDS = 300;

/** Sort key of a draft head: later than any ISO time, so a draft sits at the far end. */
export const DRAFT_STARTED_AT = "9999";

export function readHeadOrder(settings: Record<string, unknown>): string[] {
  const raw = settings[HEAD_ORDER_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export interface HeadOrderItem {
  /** Row key: the session id, or a draft's placeholder id. */
  id: string;
  /** ISO start time, "" when unknown. */
  startedAt: string;
}

/** Stack order: chats Joe placed by hand keep his order, everything else follows by age,
 *  oldest first, so the newest chat sits at the far end. Nothing re-sorts on its own: a
 *  state change never moves a head, only a new chat (appended) or a drag does. */
export function orderHeads<T extends HeadOrderItem>(items: readonly T[], manual: readonly string[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed: T[] = [];
  const seen = new Set<string>();
  for (const id of manual) {
    const item = byId.get(id);
    if (item && !seen.has(id)) { placed.push(item); seen.add(id); }
  }
  const rest = items
    .filter((i) => !seen.has(i.id))
    // Same-time rows keep their incoming order (Array.sort is stable).
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return [...placed, ...rest];
}

/** The order to store after Joe drops `moved` at `toIndex` of the visible stack.
 *  Ids that are not on screen (hidden chats, chats on a machine that is offline)
 *  keep their place at the end of the stored list so they return where they were. */
export function reorderStored(visible: readonly string[], moved: string, toIndex: number, stored: readonly string[]): string[] {
  const without = visible.filter((id) => id !== moved);
  const at = Math.max(0, Math.min(toIndex, without.length));
  const next = [...without.slice(0, at), moved, ...without.slice(at)];
  const shown = new Set(next);
  const offScreen = stored.filter((id) => !shown.has(id));
  // The cap trims the off-screen tail (stale ids of closed chats), never the visible heads.
  return [...next, ...offScreen.slice(0, Math.max(0, MAX_ORDER_IDS - next.length))];
}

/** The keyboard highlight while Ctrl is held: up from the first head goes to the last
 *  and down from the last to the first. `-1` (nothing highlighted yet) starts at the
 *  head the direction points away from, so the first Down reads as "the next one". */
export function stepHighlight(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export interface HeadCenter { id: string; cx: number; cy: number }

/** Where a dragged head lands: its index among the other heads. The stack reads column by
 *  column (down, then the next column), so a head is "before" the nearest one when the pointer
 *  is in an earlier column, or in the same column and higher up. */
export function dropIndexFor(others: readonly HeadCenter[], x: number, y: number, columnHalf = 22): number {
  if (others.length === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  others.forEach((c, i) => {
    const d = (c.cx - x) ** 2 + (c.cy - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  const c = others[best]!;
  const before = Math.abs(x - c.cx) > columnHalf ? x < c.cx : y < c.cy;
  return before ? best : best + 1;
}

/** The red number on a closed stack's toggle: every card waiting across the heads. */
export function totalWaiting(counts: Iterable<number>): number {
  let n = 0;
  for (const c of counts) n += Math.max(0, c);
  return n;
}

/** Defined in sessions-helpers.ts (`sessionSegment` reads it); re-exported so the heads and their tests keep importing it from here. */
export { isIdleFrozen } from "./sessions-helpers";

// ── The red count: cards waiting on Joe, the same whether the chat is open or not ──

/** How long a card that left its chat's parked slot still counts for the chat that was just
 *  opened. Opening a chat takes the slot and the card mounts a daemon round trip later, so
 *  without this the count drops for the gap and comes back with the card. */
export const WAIT_HOLD_MS = 1500;

/** How often a count holding an asker under a permission or secret card looks again: that card
 *  going away fires no event. */
export const ANON_RECHECK_MS = 700;

/** An asker the open chat's count remembers: the prompt it asked, and when its slot went
 *  missing (null while the slot is there). */
export interface HeldAsker {
  promptId: string | null;
  goneAt: number | null;
  /** Its card is a permission or secret one: the question registry never names it on screen. */
  unnamed: boolean;
}

export interface WaitingInput {
  /** Askers waiting on Joe in this chat's window right now, each with the prompt it asked
   *  (null when only the registry knows). */
  raw: ReadonlyMap<string, string | null>;
  /** Prompt ids in `raw` whose card is a permission or secret one (see `HeldAsker.unnamed`). */
  unnamed?: ReadonlySet<string>;
  /** What the previous render remembered for this chat. */
  held: ReadonlyMap<string, HeldAsker>;
  /** This chat is the one on screen. */
  open: boolean;
  /** A card is up that the question registry cannot name (a permission or secret card), so no
   *  asker can be matched to it: while it is, every remembered asker with such a card keeps counting. */
  anonymousCardUp: boolean;
  /** The prompt was already answered or skipped. */
  settled: (promptId: string) => boolean;
  now: number;
}

export interface WaitingResult {
  /** Who is waiting: its length is the red number. */
  askers: string[];
  held: Map<string, HeldAsker>;
  /** When the hold of an asker still counting ends, so the caller can draw again then. */
  dueAt: number | null;
}

/** The red number of a chat head. It counts the askers waiting on Joe, and a chat Joe has
 *  opened keeps counting an asker whose slot just went missing because its card is about to
 *  mount (or is a permission or secret card the question registry cannot name), instead of
 *  letting the slot's removal read as "nothing waiting". An asker Joe answered, or whose
 *  card is gone, stops counting. */
export function resolveWaiting(i: WaitingInput): WaitingResult {
  const held = new Map<string, HeldAsker>();
  for (const [id, promptId] of i.raw) held.set(id, { promptId, goneAt: null, unnamed: promptId !== null && !!i.unnamed?.has(promptId) });
  let dueAt: number | null = null;
  if (i.open) {
    for (const [id, h] of i.held) {
      if (held.has(id) || h.promptId === null || i.settled(h.promptId)) continue;
      const goneAt = h.goneAt ?? i.now;
      const underCard = h.unnamed && i.anonymousCardUp;
      if (!underCard && i.now - goneAt >= WAIT_HOLD_MS) continue;
      // Under a card nobody can name the asker counts for as long as the card is up and stops
      // the moment it goes, so its time hold is marked spent (-Infinity). Nothing announces
      // that card going, so the caller looks again after `ANON_RECHECK_MS`.
      held.set(id, { ...h, goneAt: underCard ? -Infinity : goneAt });
      const next = underCard ? i.now + ANON_RECHECK_MS : goneAt + WAIT_HOLD_MS;
      dueAt = Math.min(dueAt ?? Infinity, next);
    }
  }
  return { askers: [...held.keys()], held, dueAt };
}

// ── The top-right badge: ONE number by priority, and a draft to send ──

/** What a chat's data says about it, before the priority rule picks what a head draws. */
export interface HeadTag {
  /** Answers Joe has not read, the number the Answers card keeps, after the chat's viewed mark. */
  unread: number;
  /** Subs of this main chat that finished after Joe last viewed it. */
  finished: number;
  /** The chat holds a draft still to send (the Drafts panel's open drafts). One mark, no count. */
  draft: boolean;
}

/** Red asks for Joe, purple is unread answers, green is finished subs. */
export type BadgeKind = "red" | "purple" | "green";

export interface HeadBadge {
  kind: BadgeKind;
  n: number;
}

/** What a head draws in its top-right corner: at most one number, and the draft pencil beside it. */
export interface HeadMark {
  badge: HeadBadge | null;
  draft: boolean;
}

/** Over this many the number reads "9+": a 44px head has no room for a third digit. */
export const UNREAD_CAP = 9;

/** The text of a count: empty at zero, the number up to nine, "9+" above. */
export function unreadLabel(n: number): string {
  if (!(n > 0)) return "";
  return n > UNREAD_CAP ? `${UNREAD_CAP}+` : String(n);
}

/** The data a chat carries, or null when there is nothing to say. */
export function tagOf(unread: number | undefined, draft: boolean | undefined, finished?: number): HeadTag | null {
  const n = unread && unread > 0 ? Math.floor(unread) : 0;
  const f = finished && finished > 0 ? Math.floor(finished) : 0;
  if (n === 0 && f === 0 && !draft) return null;
  return { unread: n, finished: f, draft: !!draft };
}

export interface BadgeInput {
  /** Cards waiting on Joe in this chat (the red count). */
  waiting: number;
  /** Unread answers after the chat's viewed mark. */
  unread: number;
  /** Finished subs after the chat's viewed mark. */
  finished: number;
  /** The chat sits behind the eye button. */
  hidden: boolean;
  /** The chat is the one on screen: Joe is looking at it, so there is nothing unseen on it. */
  open: boolean;
  draft: boolean;
}

/** The one badge a head draws. Red (a card to answer) outranks purple (an answer to read),
 *  which outranks green (a finished sub), and never two at once. A hidden chat draws no number:
 *  the eye button is where it lives. A card stays red on the open chat until it is answered;
 *  unread answers and finished subs are what viewing a chat clears. The draft pencil is not a
 *  number and stays, hidden chat or not. */
export function headMark(i: BadgeInput): HeadMark | null {
  if (i.hidden) return i.draft ? { badge: null, draft: true } : null;
  let badge: HeadBadge | null = null;
  if (i.waiting > 0) badge = { kind: "red", n: Math.floor(i.waiting) };
  else if (!i.open && i.unread > 0) badge = { kind: "purple", n: Math.floor(i.unread) };
  else if (!i.open && i.finished > 0) badge = { kind: "green", n: Math.floor(i.finished) };
  if (!badge && !i.draft) return null;
  return { badge, draft: i.draft };
}

/** How many of a main chat's subs finished after Joe last viewed that chat (and the sub itself). A
 *  sub counts once: when it finished, not each time it is listed. `viewedAt` is a chat's viewed mark in ms. */
export function finishedUnseen(
  subs: readonly { id: string; kind: string; finishedAt?: number | null }[],
  viewedAt: (id: string) => number,
  mainId: string,
): number {
  const mainSeen = viewedAt(mainId);
  let n = 0;
  for (const s of subs) {
    if (s.kind !== "finished" || !s.finishedAt) continue;
    if (s.finishedAt > Math.max(mainSeen, viewedAt(s.id))) n++;
  }
  return n;
}

export function marksEqual(a: HeadMark | null | undefined, b: HeadMark | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.draft === b.draft && a.badge?.kind === b.badge?.kind && a.badge?.n === b.badge?.n;
}

export function headTagsEqual(a: ReadonlyMap<string, HeadTag>, b: ReadonlyMap<string, HeadTag>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, t] of a) {
    const o = b.get(id);
    if (!o || o.unread !== t.unread || o.finished !== t.finished || o.draft !== t.draft) return false;
  }
  return true;
}

/** The slice of a drafts-store draft the tag reads (MessageDraft satisfies it). */
export interface DraftLike {
  state: string;
  updated_at: string;
  origin_session_id: string;
  origin_main_session_id?: string;
  variants: readonly { sent: boolean }[];
}

/** The chats holding a draft still to send: the chat that wrote it, and the main chat of a sub that
 *  did (its dashboard lists a sub's drafts too). Copied, archived, stale and fully posted drafts
 *  count for nobody. A draft with every wording posted is skipped too, as the dashboard's draft list
 *  does; the Drafts panel's open list still shows it until it is copied or archived. */
export function draftOwners(drafts: readonly DraftLike[], now: number): Set<string> {
  const out = new Set<string>();
  for (const d of drafts) {
    if (d.state === "copied" || d.state === "archived") continue;
    const touched = Date.parse(d.updated_at);
    if (!Number.isNaN(touched) && now - touched >= STALE_MS) continue;
    if (d.variants.length > 0 && d.variants.every((v) => v.sent)) continue;
    out.add(d.origin_session_id);
    if (d.origin_main_session_id) out.add(d.origin_main_session_id);
  }
  return out;
}
