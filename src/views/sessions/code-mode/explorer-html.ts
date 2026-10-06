// Code mode explorer markup: scope header (or an opened commit / PR's own
// header), the file tree, and the commits fold with its push row. Pure
// string builders over a view model, so tests can render any state.

import { escapeHtml } from "../../../shared/escape-html";
import { basename } from "../../../shared/path-utils";
import { buildTree, dirHas, type TreeNode } from "./tree";
import type { BaseScope, CommitHistoryEntry, GitState, ScopeData, ScopeRef } from "./data";

export const SCOPE_LABEL: Record<BaseScope, string> = {
  chat: "This chat",
  unpushed: "Unpushed",
  uncommitted: "Uncommitted",
  all: "All files",
};

const SCOPE_ICON: Record<BaseScope, string> = {
  chat: "ph-chat-circle",
  unpushed: "ph-cloud-arrow-up",
  uncommitted: "ph-pencil-simple",
  all: "ph-tree-structure",
};

export interface ExplorerModel {
  scope: ScopeRef;
  data: ScopeData | null;
  collapsed: Set<string>;
  activePath: string | null;
  menuOpen: boolean;
  /** Per-scope file counts for the menu; null while that one loads. */
  menuCounts: Partial<Record<BaseScope, number | null>>;
  git: GitState | null;
  commitsOpen: boolean;
  branchOpen: boolean;
  gitBusy: "push" | "pull" | null;
  gitError: string | null;
  /** Pushed commits paged in below the unpushed ones via "Show older commits". */
  older?: CommitHistoryEntry[];
  olderLoading?: boolean;
  /** True once a page comes back with no more history - hides the trigger. */
  olderDone?: boolean;
}

function countText(m: ExplorerModel): string {
  if (!m.data) return "…";
  return String(m.scope.kind === "all" ? m.data.paths.length : m.data.changed.size);
}

function scopeHeaderHtml(m: ExplorerModel): string {
  const s = m.scope;
  if (s.kind === "commit") {
    const files = m.data ? `${m.data.changed.size} file${m.data.changed.size === 1 ? "" : "s"}` : "…";
    return `<div class="cm-chead"><button class="cm-ib" data-act="scope-back" title="Back (Backspace)" aria-label="Back"><i class="ph ph-arrow-left"></i></button>`
      + `<div class="cm-ctext"><div class="cm-ctitle cm-copy" role="button" tabindex="0" data-copy="${escapeHtml(s.title)}" title="Click to copy the title">${escapeHtml(s.title)}</div>`
      + `<div class="cm-csha"><span class="cm-copy" role="button" tabindex="0" data-copy="${escapeHtml(s.sha)}" title="Click to copy the hash">${escapeHtml(s.sha.slice(0, 7))}</span> <span class="cm-cn">· ${files}</span></div></div></div>`;
  }
  if (s.kind === "pr") {
    const files = m.data ? ` · ${m.data.changed.size} file${m.data.changed.size === 1 ? "" : "s"}` : "";
    return `<div class="cm-chead"><button class="cm-ib" data-act="scope-back" title="Back (Backspace)" aria-label="Back"><i class="ph ph-arrow-left"></i></button>`
      + `<div class="cm-ctext"><div class="cm-ctitle">${escapeHtml(s.title)}</div>`
      + `<div class="cm-csha"><i class="ph ph-git-pull-request"></i> <span class="cm-cn">${s.commits.length} commit${s.commits.length === 1 ? "" : "s"}${files}</span></div></div></div>`;
  }
  if (s.kind === "branch") {
    const changedCount = m.data ? `${m.data.changed.size} changed` : "…";
    return `<div class="cm-chead"><button class="cm-ib" data-act="scope-back" title="Stop previewing (Backspace)" aria-label="Stop previewing"><i class="ph ph-arrow-left"></i></button>`
      + `<div class="cm-ctext"><div class="cm-ctitle"><i class="ph ph-eye"></i> ${escapeHtml(s.name)}</div>`
      + `<div class="cm-csha"><span class="cm-cn">Previewing · ${changedCount}</span></div></div>`
      + `<button class="cm-checkoutbtn" data-act="checkout-branch" data-branch="${escapeHtml(s.name)}" title="Check out ${escapeHtml(s.name)}"><i class="ph ph-git-branch"></i>Check out</button></div>`;
  }
  const item = (k: BaseScope) => {
    const n = m.menuCounts[k];
    return `<div class="cm-mi" role="menuitemradio" tabindex="-1" aria-checked="${s.kind === k}" data-scope="${k}"><i class="ph ${SCOPE_ICON[k]}"></i>${SCOPE_LABEL[k]}`
      + `<span class="n">${n === undefined ? "" : n === null ? "…" : n}</span><i class="ph ph-check cm-chk"></i></div>`;
  };
  const menu = m.menuOpen
    ? `<div class="cm-menu cm-scope-menu" role="menu">${item("chat")}${item("unpushed")}${item("uncommitted")}<div class="cm-sep"></div>${item("all")}</div>`
    : "";
  return `<div class="cm-files-h"><button class="cm-qtitle" data-act="menu" aria-haspopup="menu" aria-expanded="${m.menuOpen}">`
    + `${SCOPE_LABEL[s.kind]}<span class="n">${countText(m)}</span><i class="ph ph-caret-down"></i></button></div>${menu}`;
}

function treeRowsHtml(node: TreeNode, depth: number, prefix: string, m: ExplorerModel): string {
  const data = m.data!;
  const changedPaths = data.changed.keys();
  const changed = [...changedPaths];
  const inCommit = m.scope.kind === "commit" || m.scope.kind === "pr";
  const pad = (d: number) => `style="padding-left:${8 + d * 12}px"`;
  let out = "";
  for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dir = prefix + name;
    const open = !m.collapsed.has(dir);
    const dot = !open && dirHas(dir, changed) ? `<span class="end"><span class="cm-dot" title="Has changes"></span></span>` : "";
    out += `<div class="cm-row cm-dir" role="treeitem" tabindex="0" aria-expanded="${open}" data-dir="${escapeHtml(dir)}" ${pad(depth)}>`
      + `<i class="ph ${open ? "ph-caret-down" : "ph-caret-right"}"></i><i class="ph ${open ? "ph-folder-open" : "ph-folder"}"></i>`
      + `<span class="fname">${escapeHtml(name)}</span>${dot}</div>`;
    if (open) out += treeRowsHtml(child, depth + 1, dir + "/", m);
  }
  for (const p of [...node.files].sort((a, b) => a.localeCompare(b))) {
    const f = data.changed.get(p);
    // Inside a commit every file is modified by definition, so M says nothing.
    const badge = f && !(inCommit && f.status === "M") ? `<span class="pr-file-status st-${f.status}">${f.status}</span>` : "";
    const wt = f?.wt ? `<span class="cm-wt" title="Not committed yet">WT</span>` : "";
    const cls = `${f ? " chg" : ""}${f?.wt ? " wt" : ""}${m.activePath === p ? " active" : ""}`;
    out += `<div class="cm-row cm-file${cls}" role="treeitem" tabindex="0" data-file="${escapeHtml(p)}" title="${escapeHtml(p)}" ${pad(depth)}>`
      + `<span class="cm-caret-pad"></span><i class="ph ph-file"></i><span class="fname">${escapeHtml(basename(p))}</span>`
      + `<span class="end">${wt}${badge}</span></div>`;
  }
  return out;
}

function treeHtml(m: ExplorerModel): string {
  if (!m.data) return `<div class="cm-tree" role="tree"><div class="cm-note"><i class="ph ph-spinner-gap cm-spin"></i> Loading files&hellip;</div></div>`;
  if (m.data.error) return `<div class="cm-tree" role="tree"><div class="cm-note cm-err">${escapeHtml(m.data.error)}</div></div>`;
  if (!m.data.paths.length) {
    const empty: Record<string, string> = {
      chat: "This chat hasn't edited any files yet.",
      unpushed: "Nothing unpushed. Everything is on origin.",
      uncommitted: "No uncommitted changes.",
      branch: "This branch has no files.",
    };
    return `<div class="cm-tree" role="tree"><div class="cm-note">${empty[m.scope.kind] ?? "No files."}</div></div>`;
  }
  return `<div class="cm-tree" role="tree" aria-label="Files">${treeRowsHtml(buildTree(m.data.paths), 0, "", m)}</div>`;
}

function foldSummary(git: GitState | null): string {
  const sync = git?.sync;
  if (!sync) return "";
  if (!sync.has_upstream) return "not published";
  if (sync.ahead.length) return `${sync.ahead.length} unpushed`;
  return "up to date";
}

/** Shared by the unpushed rows and the "Show older commits" ones below them -
 *  same markup, same click target (events.ts's delegated `data-commit`), so
 *  opening a historical commit works exactly like opening an unpushed one. */
function commitRowHtml(c: CommitHistoryEntry | { short_sha: string; message: string }, openSha: string | null, older: boolean): string {
  const on = openSha && c.short_sha.startsWith(openSha.slice(0, 7)) ? " on" : "";
  // A quiet icon, not a badge, says "already on origin" for a row otherwise
  // identical to an unpushed one.
  const icon = older ? `<i class="ph ph-check cm-older-ic"></i>` : "";
  return `<div class="cm-commit${older ? " cm-older" : ""}${on}" role="button" tabindex="0" data-commit="${escapeHtml(c.short_sha)}" data-title="${escapeHtml(c.message)}" title="Open this commit">`
    + `${icon}<code>${escapeHtml(c.short_sha)}</code><span>${escapeHtml(c.message)}</span></div>`;
}

/** The trigger row at the end of the fold. Hidden once a page comes back
 *  exhausted; while loading it swaps its icon for a spinner in place. */
function olderTriggerHtml(m: ExplorerModel): string {
  if (m.olderDone) return "";
  const icon = m.olderLoading ? `<i class="ph ph-spinner-gap cm-spin"></i>` : `<i class="ph ph-clock-counter-clockwise"></i>`;
  return `<div class="cm-commit cm-older-trigger" role="button" tabindex="0" data-act="older-commits"${m.olderLoading ? ` aria-busy="true"` : ""}>`
    + `${icon}<span>Show older commits</span></div>`;
}

function commitsHtml(m: ExplorerModel): string {
  const git = m.git;
  const sync = git?.sync;
  if (!m.commitsOpen || !sync) return "";
  const openSha = m.scope.kind === "commit" ? m.scope.sha : null;
  const rows = sync.ahead.map((c) => commitRowHtml(c, openSha, false)).join("");
  // Browsing already-pushed history needs an upstream to mean
  // anything - with none, get_commit_history flags every commit unpushed.
  const olderRows = sync.has_upstream ? (m.older ?? []).map((c) => commitRowHtml(c, openSha, true)).join("") : "";
  const olderTrigger = sync.has_upstream ? olderTriggerHtml(m) : "";
  const branchName = git.branch ?? "HEAD";
  const target = git.upstream ?? `origin/${branchName}`;
  const spin = `<i class="ph ph-spinner-gap cm-spin"></i>`;
  const n = sync.ahead.length;
  const pull = sync.behind.length
    ? `<div class="cm-commit cm-actrow"><button class="cm-pushtext" data-act="pull"${m.gitBusy ? " disabled" : ""} title="Pull ${sync.behind.length} commit${sync.behind.length === 1 ? "" : "s"} from ${escapeHtml(target)}">`
      + `${m.gitBusy === "pull" ? spin : `<i class="ph ph-arrow-down"></i>`}Pull ${sync.behind.length} commit${sync.behind.length === 1 ? "" : "s"}</button></div>`
    : "";
  const pushLabel = !sync.has_upstream ? `Publish ${escapeHtml(branchName)}` : n ? `Push ${n} commit${n === 1 ? "" : "s"}` : "Nothing to push";
  const canPush = !sync.has_upstream || n > 0;
  const pushIcon = m.gitBusy === "push" ? spin : `<i class="ph ${sync.has_upstream ? "ph-arrow-up" : "ph-cloud-arrow-up"}"></i>`;
  const push = `<div class="cm-commit cm-actrow cm-pushrow"><button class="cm-pushtext" data-act="push"${canPush && !m.gitBusy ? "" : " disabled"} title="${sync.has_upstream ? `Push to ${escapeHtml(target)}` : "Publish this branch to origin"}">${pushIcon}${pushLabel}</button>`
    + `<span class="grow"></span><button class="cm-branchbtn${m.branchOpen ? " on" : ""}" data-act="branch" aria-haspopup="dialog" aria-expanded="${m.branchOpen}" title="Switch branch">`
    + `<i class="ph ph-git-branch"></i><span>${escapeHtml(sync.has_upstream ? target : branchName)}</span><i class="ph ph-caret-up"></i></button></div>`;
  const err = m.gitError ? `<div class="cm-giterr"><i class="ph ph-warning"></i>${escapeHtml(m.gitError)}</div>` : "";
  return `<div class="cm-commits">${rows}${pull}${push}${err}${olderRows}${olderTrigger}</div>`;
}

export function explorerHtml(m: ExplorerModel): string {
  const fold = m.git?.sync
    ? `<div class="cm-fold" role="button" tabindex="0" data-act="fold" aria-expanded="${m.commitsOpen}">`
      + `<i class="ph ${m.commitsOpen ? "ph-caret-down" : "ph-caret-up"}"></i><span>Commits</span><span class="grow"></span><span class="cm-qn">${foldSummary(m.git)}</span></div>`
    : "";
  const bmenu = m.branchOpen && m.commitsOpen ? `<div class="cm-bmenu" role="dialog" aria-label="Switch branch"></div>` : "";
  return scopeHeaderHtml(m) + treeHtml(m) + fold + commitsHtml(m) + bmenu;
}
