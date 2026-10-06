// Code mode's git data: what each explorer scope lists, and the SurfaceFile
// each listed file opens as. Pure async over invoke, no DOM.

import { invoke } from "../../../shared/ipc";
import type { SurfaceFile } from "../../../shared/chat/file-surface";
import type { FileEditView } from "../../../shared/chat/file-edits";
import type { BranchEntry, CommitHistory, CommitHistoryEntry, CommitSync, GitInfo, PrFileChange, TextFileData } from "../../../types/ipc.generated";

export type { CommitHistoryEntry };
import { OUTSIDE_DIR, repoRelative, statusLetter, type FileStatus } from "./tree";

import type { CodeModeScope, PrCommit } from "../../../shared/chat/code-mode-bridge";

export type BaseScope = CodeModeScope;
export type { PrCommit };

export type ScopeRef =
  | { kind: BaseScope }
  | { kind: "commit"; sha: string; title: string }
  | { kind: "pr"; title: string; commits: PrCommit[] }
  /** Read-only preview of another branch's tree, entered from the branch
   *  switcher's Preview action - no checkout happens. */
  | { kind: "branch"; name: string };

export interface ScopeFile {
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  /** Changed in the working tree, not committed yet. */
  wt: boolean;
  surface: SurfaceFile;
}

export interface ScopeData {
  /** Changed files in this scope, by repo-relative path. */
  changed: Map<string, ScopeFile>;
  /** Every path the tree shows: the changed ones, or the whole repo for "all". */
  paths: string[];
  error: string | null;
}

export interface GitState {
  sync: CommitSync | null;
  branch: string | null;
  upstream: string | null;
}

export interface ScopeCtx {
  cwd: string;
  /** This chat's own edits, newest last. */
  edits: FileEditView[];
}

// Big enough that git keeps every line of any file this viewer would render.
const FULL_FILE_CONTEXT = 1_000_000;

function absPath(cwd: string, path: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

/** A git range rendered as `(from, to]`, or `from` against the working tree
 *  when `to` is null (see get_range_files' doc comment). */
interface Range {
  from: string | null;
  to: string | null;
}

function gitSurface(cwd: string, f: PrFileChange, range: Range): SurfaceFile {
  const deleted = statusLetter(f.status) === "D";
  // A deleted file only exists before the change: the commit's parent, or the
  // working-tree diff's base.
  const rev = deleted ? (range.to ? `${range.to}^` : range.from ?? "HEAD") : range.to;
  return {
    path: f.path,
    absPath: absPath(cwd, f.path),
    added: f.added,
    removed: f.removed,
    gitDiff: ({ full }) =>
      invoke<string>("get_file_diff", {
        cwd, from: range.from, to: range.to, path: f.path, context: full ? FULL_FILE_CONTEXT : null,
      }),
    fileAtRev: () => invoke<TextFileData>("get_file_at_rev", { cwd, rev, path: f.path }),
  };
}

/** An unchanged file: no diff, its working-tree content. */
export function plainSurface(cwd: string, path: string): SurfaceFile {
  return {
    path,
    absPath: absPath(cwd, path),
    fileAtRev: () => invoke<TextFileData>("get_file_at_rev", { cwd, rev: null, path }),
  };
}

/** A file inside a branch preview: always reads the branch's own committed
 *  content via `get_file_at_rev(rev: branch)`, never the working tree - this
 *  scope never checks the branch out. `f` is present only for a file the
 *  HEAD-vs-branch diff flagged as changed, which adds a diff view. */
export function branchFileSurface(cwd: string, path: string, branch: string, f?: PrFileChange): SurfaceFile {
  return {
    path,
    absPath: absPath(cwd, path),
    added: f?.added,
    removed: f?.removed,
    gitDiff: f
      ? ({ full }) => invoke<string>("get_file_diff", { cwd, from: null, to: branch, base: "HEAD", path, context: full ? FULL_FILE_CONTEXT : null })
      : undefined,
    fileAtRev: () => invoke<TextFileData>("get_file_at_rev", { cwd, rev: branch, path }),
  };
}

/** What `git status` says is uncommitted. An untracked folder comes back as
 *  just `dir/`, so it marks every file under it. */
interface Dirty {
  paths: Set<string>;
  dirs: string[];
}

function isDirty(d: Dirty | null, path: string): boolean {
  return !!d && (d.paths.has(path) || d.dirs.some((dir) => path.startsWith(dir)));
}

async function rangeFiles(cwd: string, range: Range, dirty: Dirty | null): Promise<Map<string, ScopeFile>> {
  const files = await invoke<PrFileChange[]>("get_range_files", { cwd, from: range.from, to: range.to });
  const out = new Map<string, ScopeFile>();
  for (const f of files) {
    out.set(f.path, {
      path: f.path,
      status: statusLetter(f.status),
      added: f.added,
      removed: f.removed,
      wt: isDirty(dirty, f.path),
      surface: gitSurface(cwd, f, range),
    });
  }
  return out;
}

/** `git status --porcelain` paths, quotes stripped: what is uncommitted. */
async function dirtyPaths(cwd: string): Promise<Dirty> {
  const raw = await invoke<string[]>("get_git_dirty", { cwd }).catch(() => [] as string[]);
  // A rename prints `old -> new`; the new path is the one the tree shows.
  const all = raw.map((p) => p.split(" -> ").pop()!.replace(/^"|"$/g, ""));
  return { paths: new Set(all.filter((p) => !p.endsWith("/"))), dirs: all.filter((p) => p.endsWith("/")) };
}

/** What a push would send, plus what is not even committed yet: everything
 *  between the upstream and the working tree. Without an upstream there is
 *  nothing pushed to compare against, so it falls back to HEAD. */
async function unpushedRange(cwd: string): Promise<Range> {
  const sync = await invoke<CommitSync>("get_commit_sync", { cwd }).catch(() => null);
  return { from: sync?.has_upstream ? "@{u}" : "HEAD", to: null };
}

/** This chat's own edits, one entry per file, newest edit kind deciding the
 *  badge: a file the chat created reads A, anything else M. */
export function chatFiles(ctx: ScopeCtx): Map<string, ScopeFile> {
  const byPath = new Map<string, FileEditView[]>();
  for (const e of ctx.edits) {
    const rel = repoRelative(ctx.cwd, e.path);
    const list = byPath.get(rel) ?? [];
    list.push(e);
    byPath.set(rel, list);
  }
  const out = new Map<string, ScopeFile>();
  for (const [path, edits] of byPath) {
    const outside = path.startsWith(`${OUTSIDE_DIR}/`);
    const abs = edits[0]!.path;
    out.set(path, {
      path,
      status: edits[0]!.kind === "write" ? "A" : "M",
      added: edits.reduce((n, e) => n + e.addedLines, 0),
      removed: edits.reduce((n, e) => n + e.removedLines, 0),
      wt: false,
      surface: {
        path,
        absPath: outside ? abs : absPath(ctx.cwd, path),
        added: edits.reduce((n, e) => n + e.addedLines, 0),
        removed: edits.reduce((n, e) => n + e.removedLines, 0),
        sessionEdits: edits,
        // A file outside the repo can't be read through the repo-confined
        // working-tree read; its diff is all this view has.
        fileAtRev: outside
          ? () => Promise.reject(new Error("This file is outside the chat's repo; only its diff is available."))
          : () => invoke<TextFileData>("get_file_at_rev", { cwd: ctx.cwd, rev: null, path }),
      },
    });
  }
  return out;
}

export async function loadScope(ctx: ScopeCtx, ref: ScopeRef): Promise<ScopeData> {
  const { cwd } = ctx;
  try {
    switch (ref.kind) {
      case "chat": {
        const changed = chatFiles(ctx);
        return { changed, paths: [...changed.keys()], error: null };
      }
      case "uncommitted": {
        const changed = await rangeFiles(cwd, { from: "HEAD", to: null }, null);
        return { changed, paths: [...changed.keys()], error: null };
      }
      case "unpushed": {
        const [range, dirty] = await Promise.all([unpushedRange(cwd), dirtyPaths(cwd)]);
        const changed = await rangeFiles(cwd, range, dirty);
        return { changed, paths: [...changed.keys()], error: null };
      }
      case "all": {
        const [range, dirty, all] = await Promise.all([
          unpushedRange(cwd),
          dirtyPaths(cwd),
          invoke<string[]>("list_project_files", { projectDir: cwd }),
        ]);
        const changed = await rangeFiles(cwd, range, dirty);
        const paths = new Set(all.map((p) => p.replace(/\\/g, "/")));
        for (const p of changed.keys()) paths.add(p);
        return { changed, paths: [...paths], error: null };
      }
      case "commit": {
        const changed = await rangeFiles(cwd, { from: null, to: ref.sha }, null);
        return { changed, paths: [...changed.keys()], error: null };
      }
      case "pr": {
        const newest = ref.commits[0];
        const oldest = ref.commits[ref.commits.length - 1];
        if (!newest || !oldest) return { changed: new Map(), paths: [], error: null };
        const range = { from: ref.commits.length > 1 ? oldest.sha : null, to: newest.sha };
        const changed = await rangeFiles(cwd, range, null);
        return { changed, paths: [...changed.keys()], error: null };
      }
      case "branch": {
        const { name } = ref;
        const [branchPaths, prFiles] = await Promise.all([
          invoke<string[]>("list_branch_files", { cwd, branch: name }),
          // What the branch changes relative to the current HEAD: an exact
          // HEAD..branch diff, not the working tree (this scope never checks
          // the branch out, so the working tree has nothing to do with it).
          invoke<PrFileChange[]>("get_range_files", { cwd, from: null, to: name, base: "HEAD" }),
        ]);
        const changed = new Map<string, ScopeFile>();
        for (const f of prFiles) {
          changed.set(f.path, {
            path: f.path,
            status: statusLetter(f.status),
            added: f.added,
            removed: f.removed,
            wt: false,
            surface: branchFileSurface(cwd, f.path, name, f),
          });
        }
        const paths = new Set(branchPaths.map((p) => p.replace(/\\/g, "/")));
        for (const p of changed.keys()) paths.add(p);
        return { changed, paths: [...paths], error: null };
      }
    }
  } catch (err) {
    return { changed: new Map(), paths: [], error: String(err) };
  }
}

/** Commits fetched per "Show older commits" click. */
export const OLDER_COMMITS_PAGE = 30;

/** One page of the branch's full `git log HEAD`, continuing from `offset`.
 *  Includes unpushed commits too (the log interleaves them by date) - the
 *  caller filters to `pushed` entries not already shown by the unpushed rows. */
export async function loadCommitHistoryPage(cwd: string, offset: number): Promise<CommitHistory> {
  return invoke<CommitHistory>("get_commit_history", { cwd, offset, limit: OLDER_COMMITS_PAGE });
}

/** Branch, upstream and ahead/behind for the commits fold and its push row. */
export async function loadGitState(cwd: string): Promise<GitState> {
  const [sync, info, branches] = await Promise.all([
    invoke<CommitSync>("get_commit_sync", { cwd }).catch(() => null),
    invoke<GitInfo>("get_git_info", { cwd }).catch(() => null),
    invoke<BranchEntry[]>("get_recent_branches", { cwd }).catch(() => [] as BranchEntry[]),
  ]);
  return {
    sync,
    branch: info?.branch ?? null,
    upstream: branches.find((b) => b.current)?.upstream ?? null,
  };
}
