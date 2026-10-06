// Code mode's commits fold: push/pull, paging the pushed history behind
// "Show older commits", and the branch switcher it pops open. Functions
// over the instance, the same shape events.ts uses for this class.

import { invoke } from "../../../shared/ipc";
import { BranchSwitcher } from "./branch-switcher";
import { loadCommitHistoryPage, loadGitState } from "./data";
import { isCurrent, type CodeModeInstance } from "./code-mode";

export async function loadGit(inst: CodeModeInstance): Promise<void> {
  const git = await loadGitState(inst.chat.cwd);
  if (!isCurrent(inst)) return;
  inst.git = git;
  inst.renderExplorer();
}

export function resetOlderCommits(inst: CodeModeInstance): void {
  inst.older = [];
  inst.olderOffset = 0;
  inst.olderLoading = false;
  inst.olderDone = false;
}

export async function runGit(inst: CodeModeInstance, kind: "push" | "pull"): Promise<void> {
  if (inst.gitBusy) return;
  const cwd = inst.chat.cwd;
  inst.gitBusy = kind;
  inst.gitError = null;
  inst.renderExplorer();
  try {
    if (kind === "push") await invoke<void>("push_commits", { cwd, publish: !inst.git?.sync?.has_upstream });
    else await invoke<void>("pull_commits", { cwd });
    inst.chat.onGitChanged?.();
  } catch (e) {
    inst.gitError = e instanceof Error ? e.message : String(e);
  }
  inst.gitBusy = null;
  if (!isCurrent(inst)) return;
  inst.reload();
}

/** Fetches the next page of pushed history. Dedupes against
 *  the unpushed rows above it (`sync.ahead`): the API already flags those
 *  `pushed: false`, but a push mid-session could race a stale `inst.git`,
 *  so both checks apply. */
export async function loadOlderCommits(inst: CodeModeInstance): Promise<void> {
  if (inst.olderLoading || inst.olderDone) return;
  const cwd = inst.chat.cwd;
  inst.olderLoading = true;
  inst.renderExplorer();
  try {
    const page = await loadCommitHistoryPage(cwd, inst.olderOffset);
    if (!isCurrent(inst) || inst.chat.cwd !== cwd) return;
    inst.olderOffset += page.entries.length;
    const unpushedShas = new Set(inst.git?.sync?.ahead.map((c) => c.short_sha) ?? []);
    inst.older = inst.older.concat(page.entries.filter((e) => e.pushed && !unpushedShas.has(e.short_sha)));
    inst.olderDone = !page.has_more;
  } catch (e) {
    console.error("[code-mode] get_commit_history failed", e);
  }
  inst.olderLoading = false;
  if (!isCurrent(inst)) return;
  inst.renderExplorer();
}

/** The explorer header's Check out button on a branch preview: reuses the
 *  branch switcher's own checkout + warnings rather than invoking
 *  checkout_branch a second, duplicate way. */
export function openCheckoutFor(inst: CodeModeInstance, name: string): void {
  inst.view.commitsOpen = true;
  inst.branchOpen = true;
  inst.checkoutSeed = name;
  inst.renderExplorer();
}

/** Mounts the branch switcher into the `.cm-bmenu` slot `explorerHtml` just
 *  rendered, when the commits fold's branch popover is open; drops the stale
 *  reference otherwise. */
export function mountBranchSwitcher(inst: CodeModeInstance, ex: HTMLElement): void {
  const bmenu = ex.querySelector<HTMLElement>(".cm-bmenu");
  if (!bmenu) {
    inst.branchSwitcher = null;
    return;
  }
  const seed = inst.checkoutSeed;
  inst.checkoutSeed = null;
  inst.branchSwitcher = new BranchSwitcher({
    cwd: inst.chat.cwd,
    sessionId: inst.chat.sessionId,
    initialFilter: seed ?? undefined,
    onCheckedOut: () => {
      inst.branchOpen = false;
      inst.chat.onGitChanged?.();
      inst.reload();
    },
    onClose: () => {
      inst.branchOpen = false;
      inst.renderExplorer();
      ex.querySelector<HTMLElement>(".cm-branchbtn")?.focus();
    },
    onPreview: (name) => {
      inst.branchOpen = false;
      inst.enterScope({ kind: "branch", name }, true);
    },
  });
  inst.branchSwitcher.mount(bmenu);
}
