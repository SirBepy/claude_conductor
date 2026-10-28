// The Backlog panel's pure rules: how a fetched AiBacklog becomes list groups,
// what a drop means to PLAN.md, and what the reader shows. No DOM here, so the
// rules unit-test without a browser.

import type { AiBacklog, AiTodoDoc, AiTodoEntry, AiTodoSection } from "../../../types/ipc.generated";

/** One list group. `name` is the PLAN.md `## ` heading; the unplanned group
 *  has no heading, so it is keyed by `null` rather than by its display label
 *  and can never collide with a plan group that happens to be called Backlog. */
export interface ListGroup {
  name: string | null;
  items: AiTodoEntry[];
}

export const UNPLANNED_LABEL = "Backlog";

const byPlanOrder = (a: AiTodoEntry, b: AiTodoEntry): number =>
  (a.plan_index ?? Number.MAX_SAFE_INTEGER) - (b.plan_index ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);

/** Plan groups in PLAN.md order (empty ones kept, so a row can be dropped into
 *  them), each sorted by plan order, then the unplanned group, newest first. */
export function buildListGroups(b: AiBacklog): ListGroup[] {
  const names = [...b.groups];
  // A todo naming a group the heading list lacks must still show up somewhere.
  for (const t of b.todos) if (t.group != null && !names.includes(t.group)) names.push(t.group);
  const out: ListGroup[] = names.map((name) => ({
    name,
    items: b.todos.filter((t) => t.group === name).sort(byPlanOrder),
  }));
  out.push({
    name: null,
    items: b.todos.filter((t) => t.group == null).sort((x, y) => y.mtime_ms - x.mtime_ms || x.name.localeCompare(y.name)),
  });
  return out;
}

export function isEmptyBacklog(b: AiBacklog): boolean {
  return b.todos.length === 0;
}

/** What `ai_todo_plan_move` is called with. */
export interface PlanMove {
  id: string;
  /** `null` unplans the todo. */
  group: string | null;
  /** Position among the target group's other visible items; the backend
   *  removes the todo from its old line before inserting, so the dragged row
   *  is never counted. */
  index: number;
}

/** Where a drop landed: a group, and the row it went in front of (`null` =
 *  after the group's last row). */
export interface DropSpot {
  group: string | null;
  beforeId: string | null;
}

export function moveForDrop(groups: ListGroup[], dragId: string, spot: DropSpot): PlanMove {
  const target = groups.find((g) => g.name === spot.group);
  const rest = (target?.items ?? []).filter((t) => t.id !== dragId);
  const at = spot.beforeId == null ? -1 : rest.findIndex((t) => t.id === spot.beforeId);
  return { id: dragId, group: spot.group, index: at < 0 ? rest.length : at };
}

/** True when the drop would put the row exactly where it already is. */
export function isNoopMove(groups: ListGroup[], move: PlanMove): boolean {
  const from = groups.find((g) => g.items.some((t) => t.id === move.id));
  if (!from) return false;
  if (from.name !== move.group) return false;
  // Unplanned order is by age, not by position, so a drop there changes nothing.
  if (move.group == null) return true;
  return from.items.findIndex((t) => t.id === move.id) === move.index;
}

/** The backlog as it will look once `move` lands, for the optimistic repaint. */
export function applyMove(b: AiBacklog, move: PlanMove): AiBacklog {
  const groups = buildListGroups(b);
  const moved = groups.flatMap((g) => g.items).find((t) => t.id === move.id);
  if (!moved) return b;
  for (const g of groups) g.items = g.items.filter((t) => t.id !== move.id);
  const target = groups.find((g) => g.name === move.group);
  if (!target) return b;
  if (move.group == null) target.items.push({ ...moved, group: null, plan_index: null });
  else target.items.splice(Math.min(move.index, target.items.length), 0, { ...moved, group: move.group });
  let n = 0;
  const todos: AiTodoEntry[] = [];
  for (const g of groups) {
    for (const t of g.items) {
      if (g.name == null) todos.push({ ...t, group: null, plan_index: null });
      else todos.push({ ...t, group: g.name, plan_index: n++ });
    }
  }
  return { groups: b.groups, todos };
}

/** `names` with `drag` moved in front of `before` (`null` = to the end). */
export function reorderedGroups(names: string[], drag: string, before: string | null): string[] {
  const rest = names.filter((n) => n !== drag);
  const at = before == null ? -1 : rest.indexOf(before);
  rest.splice(at < 0 ? rest.length : at, 0, drag);
  return rest;
}

export function applyGroupOrder(b: AiBacklog, names: string[]): AiBacklog {
  return { ...b, groups: names };
}

// ── Reader ─────────────────────────────────────────────────────────────────

export interface ReaderSection {
  heading: string;
  /** What the summary row says: the file's `Acceptance` reads as Joe's phrase. */
  label: string;
  markdown: string;
  open: boolean;
}

const OPEN_BY_DEFAULT = new Set(["context", "approach", "goal"]);

/** File order, blank sections dropped (an empty details is a dead disclosure).
 *  `why` is never among them: the backend lifts it out into `doc.why`. */
export function readerSections(sections: AiTodoSection[]): ReaderSection[] {
  return sections
    .filter((s) => s.markdown.trim() !== "")
    .map((s) => {
      const key = s.heading.trim().toLowerCase();
      return {
        heading: s.heading,
        label: key === "acceptance" ? "Done when" : s.heading,
        markdown: s.markdown,
        open: OPEN_BY_DEFAULT.has(key),
      };
    });
}

/** The Why block's text, or null when the todo has none worth a block. */
export function readerWhy(doc: AiTodoDoc): string | null {
  const w = doc.why?.trim();
  return w ? w : null;
}

/** Worth is 0-10 on disk; the reader shows five dots. */
export function worthDots(worth: number | null): { on: number; total: number } | null {
  if (worth == null) return null;
  const on = Math.max(0, Math.min(5, Math.round(worth / 2)));
  return { on, total: 5 };
}

/** The footer's actions write PLAN.md and todo files on this machine's disk, so
 *  they exist only for the desktop pipe on a chat this daemon hosts. */
export function canAct(opts: { remote: boolean; mirrored: boolean }): boolean {
  return !opts.remote && !opts.mirrored;
}

/** Row meta line: `pc-1407 · hard`. */
export function metaLine(t: AiTodoEntry): string {
  return t.complexity ? `${t.id} · ${t.complexity.toLowerCase()}` : t.id;
}
