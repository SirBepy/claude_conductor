// The todos the project dashboard's Due card is pointing at. The Backlog panel
// paints its matching rows. Held in memory on purpose: a highlight is a glance
// aid, and nothing about it is worth surviving a reload.

import { normCwd } from "../project-dashboard/due-model";

type Listener = () => void;

let selection: string | null = null;
let keys = new Set<string>();
let hitRepos: string[] = [];
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
  hitRepos = sel === null ? [] : ids.map((d) => d.repo_cwd);
  for (const l of [...listeners]) l();
}

export const dueSelection = (): string | null => selection;
export const isDueHit = (id: string, repoCwd: string): boolean => keys.has(hitKey(id, repoCwd));

export function onDueHighlight(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Folder names of the repos that own highlighted todos but are not `cwd`, with how many each.
 *  The panel lists one repo at a time, so in a group dashboard these hits are real but cannot be painted here. */
export function dueHitsElsewhere(cwd: string | null): Array<{ name: string, count: number }> {
  const here = cwd === null ? null : normCwd(cwd);
  const byRepo = new Map<string, { name: string, count: number }>();
  for (const r of hitRepos) {
    const key = normCwd(r);
    if (key === here) continue;
    const row = byRepo.get(key);
    if (row) row.count++;
    else byRepo.set(key, { name: r.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || r, count: 1 });
  }
  return [...byRepo.values()];
}

/** The panel's note for hits it cannot show, or "" when every hit is in its own repo. */
export function dueElsewhereNote(cwd: string | null): string {
  const rows = dueHitsElsewhere(cwd);
  if (!rows.length) return "";
  return `Also due in ${rows.map((r) => `${r.name} (${r.count})`).join(", ")}. Open a chat in that repo to see them here.`;
}
