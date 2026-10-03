// Commit shas mentioned in chat (`8a180b5`) become links to that commit, but
// only once the session's repo confirms the sha names a real commit. The
// markdown pass (markCommitCandidates in markdown-highlight.ts) wraps every
// sha-shaped word in an inert span; resolveCommitRefs then asks git about them
// in one batch per message and upgrades the confirmed ones. Clicking opens
// that commit in Code mode.

import { invoke } from "../ipc";
import { openInCodeMode } from "./code-mode-bridge";
import type { CommitRef } from "../../types/ipc.generated";

// Per-repo answers, including misses (null), so a streaming bubble that is
// rebuilt on every delta re-links instantly instead of flickering or
// re-asking git.
const cache = new Map<string, Map<string, CommitRef | null>>();
const byEl = new WeakMap<HTMLElement, { ref: CommitRef; cwd: string }>();

function apply(el: HTMLElement, ref: CommitRef, cwd: string): void {
  el.classList.add("resolved");
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.title = `${ref.subject}\n${ref.author}, ${new Date(ref.date).toLocaleString()}`;
  byEl.set(el, { ref, cwd });
}

export async function resolveCommitRefs(root: HTMLElement, cwd: string | undefined): Promise<void> {
  if (!cwd) return;
  const spans = Array.from(root.querySelectorAll<HTMLElement>(".commit-ref:not(.resolved)"));
  if (spans.length === 0) return;
  let known = cache.get(cwd);
  if (!known) cache.set(cwd, (known = new Map()));
  const pending = new Map<string, HTMLElement[]>();
  for (const el of spans) {
    const sha = el.dataset.sha ?? "";
    const hit = known.get(sha);
    if (hit) apply(el, hit, cwd);
    else if (hit === undefined) pending.set(sha, [...(pending.get(sha) ?? []), el]);
  }
  if (pending.size === 0) return;
  let refs: CommitRef[];
  try {
    refs = await invoke<CommitRef[]>("resolve_commit_refs", { cwd, candidates: [...pending.keys()] });
  } catch {
    return; // not cached: a transient failure shouldn't unlink the sha for the session
  }
  const found = new Map(refs.map((r) => [r.query, r]));
  for (const [sha, els] of pending) {
    const ref = found.get(sha) ?? null;
    known.set(sha, ref);
    if (ref) els.forEach((el) => el.isConnected && apply(el, ref, cwd));
  }
}

function activate(e: Event): void {
  const el = (e.target as Element).closest<HTMLElement>(".commit-ref.resolved");
  const hit = el ? byEl.get(el) : undefined;
  if (!hit) return;
  e.preventDefault();
  openInCodeMode({ kind: "commit", sha: hit.ref.sha, title: hit.ref.subject });
}

export function handleCommitRefClick(e: MouseEvent): void {
  activate(e);
}

export function handleCommitRefKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") activate(e);
}
