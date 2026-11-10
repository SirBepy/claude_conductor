// The todos the project dashboard's Due card is pointing at. The Backlog panel
// paints its matching rows. Held in memory on purpose: a highlight is a glance
// aid, and nothing about it is worth surviving a reload.

type Listener = () => void;

let selection: string | null = null;
let keys = new Set<string>();
const listeners = new Set<Listener>();

function norm(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** A todo id is only unique within its repo, and a group holds several. */
export function hitKey(id: string, repoCwd: string): string {
  return `${norm(repoCwd)}\n${id}`;
}

/** Highlights exactly `ids` under `sel` (null clears). */
export function setDueHighlight(sel: string | null, ids: ReadonlyArray<{ id: string, repo_cwd: string }>): void {
  selection = sel;
  keys = new Set(sel === null ? [] : ids.map((d) => hitKey(d.id, d.repo_cwd)));
  for (const l of [...listeners]) l();
}

export const dueSelection = (): string | null => selection;
export const isDueHit = (id: string, repoCwd: string): boolean => keys.has(hitKey(id, repoCwd));

export function onDueHighlight(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
