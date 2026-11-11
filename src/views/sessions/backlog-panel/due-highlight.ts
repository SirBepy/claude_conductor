// The todos the project dashboard's Due card is pointing at. The Backlog panel
// paints its matching rows. Held in memory on purpose: a highlight is a glance
// aid, and nothing about it is worth surviving a reload.

import { normCwd } from "../project-dashboard/due-model";

type Listener = () => void;

let selection: string | null = null;
let keys = new Set<string>();
const listeners = new Set<Listener>();

/** A todo id is only unique within its repo, and a group holds several. */
export function hitKey(id: string, repoCwd: string): string {
  return `${normCwd(repoCwd)}\n${id}`;
}

/** Highlights exactly `ids` under `sel` (null clears). */
export function setDueHighlight(sel: string | null, ids: ReadonlyArray<{ id: string, repo_cwd: string }>): void {
  const next = new Set(sel === null ? [] : ids.map((d) => hitKey(d.id, d.repo_cwd)));
  // Every dashboard snapshot re-applies the highlight; repainting the panel for an identical one would churn its list.
  if (sel === selection && next.size === keys.size && [...next].every((k) => keys.has(k))) return;
  selection = sel;
  keys = next;
  for (const l of [...listeners]) l();
}

export const dueSelection = (): string | null => selection;
export const isDueHit = (id: string, repoCwd: string): boolean => keys.has(hitKey(id, repoCwd));

export function onDueHighlight(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
