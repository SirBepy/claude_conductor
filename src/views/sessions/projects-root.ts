// Where "Create <name>" puts a new project.
//
// The value already existed twice before this file, both times invisibly:
// `newProjectLastParent` in settings.json (written by new-project-modal's
// Browse), and derivable from the parent directory the user's existing
// projects overwhelmingly share. Measured on the real registry 2026-09-26:
// 26 of 35 projects sat under one parent, and `newProjectLastParent` already
// held exactly that string. So this does not invent a setting, it names the
// one that was already there and makes it editable at the point of use.
//
// Pure: the settings read/write lives in the picker, so the inference rule is
// testable without IPC.

/** Settings key. Deliberately the SAME key new-project-modal already used, so
 *  an existing install starts with its remembered parent rather than being
 *  re-inferred from scratch. */
export const PROJECTS_ROOT_SETTINGS_KEY = "newProjectLastParent";

function parentOf(path: string): string | null {
  const normalized = path.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  // cut <= 2 covers "C:\x" and "/x" - a drive or filesystem root is never a
  // sensible place to drop new projects, so those paths do not vote.
  if (cut <= 2) return null;
  return normalized.slice(0, cut);
}

/** The directory most of these projects already live in, or null when there
 *  is no majority worth trusting.
 *
 *  Compares case-insensitively but returns the winner's ORIGINAL casing: the
 *  registry holds both `c:\Users\...` and `C:\Users\...` for the same folder,
 *  and lowercasing the answer would show the user a path that does not match
 *  what their other rows display. */
export function inferProjectsRoot(paths: readonly string[]): string | null {
  const counts = new Map<string, { n: number; display: string }>();
  for (const p of paths) {
    const parent = parentOf(p);
    if (!parent) continue;
    const key = parent.toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.n += 1;
    else counts.set(key, { n: 1, display: parent });
  }
  let best: { n: number; display: string } | null = null;
  for (const v of counts.values()) {
    if (!best || v.n > best.n) best = v;
  }
  // A single project tells you nothing about where the NEXT one goes; two
  // sharing a parent is the first point at which "this is where I keep them"
  // is a real signal rather than a coincidence.
  if (!best || best.n < 2) return null;
  return best.display;
}

/** The root to show in the Create row: an explicit stored choice wins over
 *  the inference, and the inference wins over nothing. Null means neither is
 *  available, and the Create action has to fall back to asking. */
export function resolveProjectsRoot(
  stored: string | null | undefined,
  projectPaths: readonly string[],
): string | null {
  if (typeof stored === "string" && stored.length > 0) return stored;
  return inferProjectsRoot(projectPaths);
}

/** Joins the root and a typed project name with the separator the root itself
 *  uses, so a Windows root does not produce a mixed `C:\a\b/c`. */
export function joinProjectPath(root: string, name: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/** Whether a typed search term could be a folder name. Gates the "Create
 *  <name>" row: offering to create `../evil` or `C:\Windows` from a search
 *  box is not a feature. */
export function isValidProjectName(name: string): boolean {
  const t = name.trim();
  if (t.length === 0) return false;
  if (t === "." || t === "..") return false;
  // Path separators, drive colons and the Windows-illegal set. Tested rather
  // than assumed: these are exactly the characters CreateDirectory rejects.
  return !/[\\/:*?"<>|]/.test(t);
}
