// Pure tree helpers for Code mode's explorer: no DOM, no IPC.

export type FileStatus = "A" | "M" | "D" | "R";

export interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: string[];
}

export function buildTree(paths: Iterable<string>): TreeNode {
  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let n = root;
    for (const d of parts.slice(0, -1)) {
      let next = n.dirs.get(d);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        n.dirs.set(d, next);
      }
      n = next;
    }
    n.files.push(p);
  }
  return root;
}

/** Every folder path the given files live under, e.g. `a`, `a/b` for `a/b/c.ts`. */
export function allDirs(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

/** True when any of `paths` sits somewhere under folder `dir`. */
export function dirHas(dir: string, paths: Iterable<string>): boolean {
  const prefix = dir + "/";
  for (const p of paths) if (p.startsWith(prefix)) return true;
  return false;
}

/** Folder path for files a chat edited outside its own repo, which have no
 *  repo-relative path to sit at. */
export const OUTSIDE_DIR = "(outside this repo)";

/** A path made relative to `cwd`, forward slashes. Windows paths compare
 *  case-insensitively. A path outside `cwd` lands under OUTSIDE_DIR. */
export function repoRelative(cwd: string, path: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(cwd);
  const p = norm(path);
  const windows = /^[a-z]:\//i.test(base);
  const hay = windows ? p.toLowerCase() : p;
  const needle = (windows ? base.toLowerCase() : base) + "/";
  if (hay.startsWith(needle)) return p.slice(needle.length);
  if (!/^([a-z]:)?\//i.test(p)) return p.replace(/^\.\//, "");
  return `${OUTSIDE_DIR}/${p.slice(p.lastIndexOf("/") + 1)}`;
}

export function statusLetter(status: string): FileStatus {
  const c = (status || "M").charAt(0).toUpperCase();
  return c === "A" || c === "D" || c === "R" ? c : "M";
}
