// Pure rules of the chat heads (docs/chat-heads-design.md): the order of the
// stack, the monogram that stands in for a project's face, which heads the
// keyboard walks, the red count. No DOM here, so tests/chat-heads-model.test.mjs
// drives every rule directly.

import type { Instance } from "../../types/ipc.generated";
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

/** A frozen chat Joe never sees: the daemon froze it for sitting done and idle, which is not a
 *  usage-limit freeze. Its head, menu and composer behave as if it were live; opening it or
 *  sending to it wakes it. The daemon never idle-freezes a chat that carries a reset time
 *  (idle_freeze.rs), so any stamp, past or not, marks the limit freeze: opening one must show
 *  its choice card, not silently send "continue". */
export function isIdleFrozen(s: { frozen?: boolean; auto_frozen?: boolean; rate_limited_resets_at?: bigint | number | null }): boolean {
  return s.frozen === true && s.auto_frozen === true && s.rate_limited_resets_at == null;
}

// ── The top-right tag: unread answers and a draft to send ──

/** What a head's tag says about its chat. */
export interface HeadTag {
  /** Answers Joe has not read, the number the Answers card keeps. */
  unread: number;
  /** The chat holds a draft still to send (the Drafts panel's open drafts). One mark, no count. */
  draft: boolean;
}

/** Over this many unread answers the tag reads "9+": a 44px head has no room for a third digit. */
export const UNREAD_CAP = 9;

/** The text of the count: empty at zero, the number up to nine, "9+" above. */
export function unreadLabel(n: number): string {
  if (!(n > 0)) return "";
  return n > UNREAD_CAP ? `${UNREAD_CAP}+` : String(n);
}

/** The tag a chat wears, or null when there is nothing to say (the head draws no tag at all). */
export function tagOf(unread: number | undefined, draft: boolean | undefined): HeadTag | null {
  const n = unread && unread > 0 ? Math.floor(unread) : 0;
  if (n === 0 && !draft) return null;
  return { unread: n, draft: !!draft };
}

/** The hidden chats' unread answers, rolled up onto the eye button: a hidden chat that got an
 *  answer must not leave the stack looking calm. Drafts do not roll up, the eye has no pencil. */
export function hiddenUnread(hiddenIds: Iterable<string>, tags: ReadonlyMap<string, HeadTag>): number {
  let n = 0;
  for (const id of hiddenIds) n += tags.get(id)?.unread ?? 0;
  return n;
}

export function headTagsEqual(a: ReadonlyMap<string, HeadTag>, b: ReadonlyMap<string, HeadTag>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, t] of a) {
    const o = b.get(id);
    if (!o || o.unread !== t.unread || o.draft !== t.draft) return false;
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

/** A draft nobody touched for a week stops counting as open (drafts-grouping.ts's `isOpen`). */
const DRAFT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** The chats holding a draft still to send: the chat that wrote it, and the main chat of a sub that
 *  did (its dashboard lists a sub's drafts too). Copied, archived, stale and fully posted drafts
 *  count for nobody. A draft with every wording posted is skipped too, as the dashboard's draft list
 *  does; the Drafts panel's open list still shows it until it is copied or archived. */
export function draftOwners(drafts: readonly DraftLike[], now: number): Set<string> {
  const out = new Set<string>();
  for (const d of drafts) {
    if (d.state === "copied" || d.state === "archived") continue;
    const touched = Date.parse(d.updated_at);
    if (!Number.isNaN(touched) && now - touched >= DRAFT_STALE_MS) continue;
    if (d.variants.length > 0 && d.variants.every((v) => v.sent)) continue;
    out.add(d.origin_session_id);
    if (d.origin_main_session_id) out.add(d.origin_main_session_id);
  }
  return out;
}
