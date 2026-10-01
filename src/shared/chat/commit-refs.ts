// Commit shas mentioned in chat (`8a180b5`) become links to that commit, but
// only once the session's repo confirms the sha names a real commit. The
// markdown pass (markCommitCandidates in markdown-highlight.ts) wraps every
// sha-shaped word in an inert span; resolveCommitRefs then asks git about them
// in one batch per message and upgrades the confirmed ones. Clicking opens the
// PR review modal scoped to that single commit.

import { invoke } from "../ipc";
import { escapeHtml } from "../escape-html";
import { renderMarkdown, utf8ToBase64 } from "./chat-transforms";
import { openPrPreviewModal } from "./pr-review-modal";
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

export function openCommitModal(ref: CommitRef, cwd: string): void {
  const card = document.createElement("div");
  card.dataset.prTitle = ref.subject;
  card.dataset.prCommits = utf8ToBase64(JSON.stringify([{ sha: ref.sha, msg: ref.subject }]));
  // No h1 here: the modal header (pr-review-modal.ts, built from dataset.prTitle
  // above) already shows this same subject - a second copy right below it was
  // pure duplication for the single-commit case.
  const shaShort = escapeHtml(ref.sha.slice(0, 7));
  const shaFull = escapeHtml(ref.sha);
  const meta = `${escapeHtml(ref.author)} · ${escapeHtml(new Date(ref.date).toLocaleString())} · <code title="${shaFull}">${shaShort}</code>`;
  const body = ref.body ? renderMarkdown(ref.body) : `<p class="commit-ref-nobody">No description</p>`;
  card.innerHTML = `<template class="pr-modal-tpl"><div class="pr-modal-body-content"><p class="commit-ref-meta">${meta}</p>${body}</div></template>`;
  openPrPreviewModal(card, { cwd, commit: true });
}

function activate(e: Event): void {
  const el = (e.target as Element).closest<HTMLElement>(".commit-ref.resolved");
  const hit = el ? byEl.get(el) : undefined;
  if (!hit) return;
  e.preventDefault();
  openCommitModal(hit.ref, hit.cwd);
}

export function handleCommitRefClick(e: MouseEvent): void {
  activate(e);
}

export function handleCommitRefKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") activate(e);
}
