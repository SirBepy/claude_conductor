// Git data layer for the PR review modal (ai_todo 248), split out of
// pr-review-modal.ts: commit-list parsing, the per-commit file cache, and
// whole-PR range resolution over get_range_files/get_file_diff. Pure async
// over invoke - no DOM. Singleton module state (one PR modal open at a
// time), mirroring the modal's own module-state pattern; resetPrReviewData
// bumps an internal generation counter so a load in flight from a closed or
// superseded modal can never write into the current state.

import { invoke } from "../ipc";
import { base64ToUtf8 } from "./chat-transforms";
import type { PrFileChange } from "../../types/ipc.generated";
import type { SurfaceFile } from "./file-surface";

export interface PrCommit {
  sha: string;
  msg: string;
}

export interface Scope {
  from: string | null;
  to: string;
}

export interface CommitStat {
  files: PrFileChange[] | null; // null while loading
  error: string | null;
}

// ── cwd provider (mirrors setFileEditsProvider in file-viewer.ts) ─────────
// Registered by whichever host currently knows the session's working
// directory (active-session.ts, history.ts, pending-pane.ts). Without a
// registration - or a git call rejecting - the sidebar/pane fall back to a
// muted unavailable state; the Description tab is unaffected either way.
let cwdProvider: (() => string | null) | null = null;
export function setPrReviewCwdProvider(fn: (() => string | null) | null): void {
  cwdProvider = fn;
}

let gen = 0;
let cwd: string | null = null;
let commits: PrCommit[] = [];
let commitStats: Map<string, CommitStat> = new Map();
let allFiles: PrFileChange[] | null = null;
let allFilesError: string | null = null;

export function parseCommits(card: HTMLElement): PrCommit[] {
  try {
    const parsed = JSON.parse(base64ToUtf8(card.dataset.prCommits ?? "")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is PrCommit => !!c && typeof c.sha === "string" && typeof c.msg === "string",
    );
  } catch {
    return [];
  }
}

/** (Re)initialize the module's state for a newly opened modal, or clear it
 *  (pass null) when the modal closes. Always bumps the generation counter,
 *  so any load already in flight for the previous card/close can never write
 *  into the state this call establishes. */
export function resetPrReviewData(card: HTMLElement | null, cwdOverride?: string): void {
  gen++;
  cwd = card ? (cwdOverride ?? cwdProvider?.() ?? null) : null;
  commits = card ? parseCommits(card) : [];
  commitStats = new Map();
  allFiles = null;
  allFilesError = null;
}

export function getCwd(): string | null {
  return cwd;
}

export function getCommits(): PrCommit[] {
  return commits;
}

export function getCommitStat(sha: string): CommitStat | undefined {
  return commitStats.get(sha);
}

export function getAllFiles(): { files: PrFileChange[] | null; error: string | null } {
  return { files: allFiles, error: allFilesError };
}

/** The whole-PR range: oldest commit (last in the array) to newest (first). */
export function wholeRangeScope(): Scope | null {
  if (commits.length === 0) return null;
  if (commits.length === 1) return { from: null, to: commits[0]!.sha };
  return { from: commits[commits.length - 1]!.sha, to: commits[0]!.sha };
}

export function commitScope(sha: string): Scope {
  return { from: null, to: sha };
}

export function toSurfaceFile(f: PrFileChange, scope: Scope): SurfaceFile {
  return {
    path: f.path,
    added: f.added,
    removed: f.removed,
    gitDiff: () => invoke<string>("get_file_diff", { cwd, from: scope.from, to: scope.to, path: f.path }),
  };
}

/** Fetch and cache each commit's own file list (from=null i.e. that single
 *  commit's diff), calling `onUpdate` after each one lands so the sidebar can
 *  redraw incrementally. No-op without a cwd. */
export async function loadCommitStats(onUpdate: () => void): Promise<void> {
  if (!cwd) return;
  const myGen = gen;
  await Promise.all(
    commits.map(async (c) => {
      try {
        const files = await invoke<PrFileChange[]>("get_range_files", { cwd, from: null, to: c.sha });
        if (myGen !== gen) return;
        commitStats.set(c.sha, { files, error: null });
      } catch (err) {
        if (myGen !== gen) return;
        commitStats.set(c.sha, { files: null, error: String(err) });
      }
      if (myGen === gen) onUpdate();
    }),
  );
}

/** Fetch and cache the whole-PR file list. No-op without a cwd or commits. */
export async function loadAllFiles(onUpdate: () => void): Promise<void> {
  const scope = wholeRangeScope();
  if (!cwd || !scope) return;
  const myGen = gen;
  try {
    const files = await invoke<PrFileChange[]>("get_range_files", { cwd, from: scope.from, to: scope.to });
    if (myGen !== gen) return;
    allFiles = files;
    allFilesError = null;
  } catch (err) {
    if (myGen !== gen) return;
    allFiles = null;
    allFilesError = String(err);
  }
  if (myGen === gen) onUpdate();
}
