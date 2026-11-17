// Pure rules of the chat heads (docs/chat-heads-design.md): the order of the
// stack, the monogram that stands in for a project's face, which heads the
// keyboard walks, the red count. No DOM here, so tests/chat-heads-model.test.mjs
// drives every rule directly.

export { monogramText, monogramHue, monogramStyle } from "../../shared/monogram";

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
