// Code mode's raw DOM event handlers, split out of code-mode.ts (todo 1073)
// since they are DOM interaction, not Code mode's state. Pure move, same
// bodies as before - each factory closes over the instance, same shape as
// chat-renderer-click-handlers.ts's createHandleXClick pattern.

import { allDirs } from "./tree";
import { openTreeContextMenu } from "./context-menu";
import type { BaseScope } from "./data";
import { DESC_TAB, type CodeModeInstance } from "./code-mode";

export function createHandleClick(inst: CodeModeInstance): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const t = e.target as HTMLElement;
    const copyEl = t.closest<HTMLElement>(".cm-copy");
    if (copyEl) {
      copy(copyEl);
      return;
    }
    if (t.closest(".cm-bmenu")) return;
    const closeBtn = t.closest<HTMLElement>("[data-close]");
    if (closeBtn) {
      e.stopPropagation();
      inst.closeTab(closeBtn.dataset.close!);
      return;
    }
    const el = t.closest<HTMLElement>("[data-act],[data-scope],[data-dir],[data-file],[data-commit],[data-tab]");
    if (!el) return;
    const d = el.dataset;
    if (d.scope) inst.setScope(d.scope as BaseScope);
    else if (d.dir !== undefined) inst.toggleDir(d.dir);
    else if (d.file) inst.openPath(d.file);
    else if (d.commit) inst.enterScope({ kind: "commit", sha: d.commit, title: d.title ?? d.commit }, true);
    else if (d.tab) inst.activate(d.tab);
    else act(inst, d.act!, el);
  };
}

function act(inst: CodeModeInstance, act: string, el: HTMLElement): void {
  switch (act) {
    case "back": inst.leave(); break;
    case "popout": inst.hooks.popOut?.(); break;
    case "dock": inst.hooks.dock?.(); break;
    case "menu":
      if (inst.menuOpen) { inst.menuOpen = false; inst.renderExplorer(); } else void inst.openMenu();
      break;
    case "scope-back": inst.scopeBack(); break;
    case "fold":
      inst.view.commitsOpen = !inst.view.commitsOpen;
      inst.branchOpen = false;
      inst.renderExplorer();
      inst.els.explorer.querySelector<HTMLElement>(".cm-fold")?.focus();
      break;
    case "branch":
      inst.branchOpen = !inst.branchOpen;
      inst.renderExplorer();
      break;
    case "push": void inst.runGit("push"); break;
    case "pull": void inst.runGit("pull"); break;
    case "older-commits": void inst.loadOlderCommits(); break;
    case "screen-explorer":
      inst.view.screen = "explorer";
      inst.showActive();
      break;
    default:
      void el;
  }
}

export function handleDblClick(e: MouseEvent): void {
  // Double-click empty tab-row space: nothing to pin, tabs are already
  // permanent; swallow so the text selection doesn't flash.
  if ((e.target as HTMLElement).closest(".cm-tabrow")) e.preventDefault();
}

export function createHandleAuxClick(inst: CodeModeInstance): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    if (e.button !== 1) return;
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".cm-tab[data-tab]");
    if (tab && tab.dataset.tab !== DESC_TAB) {
      e.preventDefault();
      inst.closeTab(tab.dataset.tab!);
    }
  };
}

export function createHandleDocClick(inst: CodeModeInstance): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const t = e.target as HTMLElement;
    if (inst.menuOpen && !t.closest(".cm-scope-menu, .cm-qtitle")) {
      inst.menuOpen = false;
      inst.renderExplorer();
    }
    if (inst.branchOpen && !t.closest(".cm-bmenu, .cm-branchbtn")) {
      inst.branchOpen = false;
      inst.renderExplorer();
    }
  };
}

export function createHandleContextMenu(inst: CodeModeInstance): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const tree = (e.target as HTMLElement).closest(".cm-tree");
    if (!tree) return;
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-file]");
    const cwd = inst.chat.cwd.replace(/[\\/]+$/, "");
    openTreeContextMenu(e.clientX, e.clientY, row?.dataset.file
      ? {
          kind: "file",
          relPath: row.dataset.file,
          absPath: `${cwd}/${row.dataset.file}`,
          onMention: inst.chat.mention
            ? (rel) => {
                inst.chat.mention!(rel);
                // In the chat's own window the message box is under this mode.
                if (!inst.hooks.focusChat) inst.close();
              }
            : null,
        }
      : {
          kind: "space",
          onExpandAll: () => { inst.view.collapsed = new Set(); inst.renderExplorer(); },
          onCollapseAll: () => { inst.view.collapsed = allDirs(inst.data?.paths ?? []); inst.renderExplorer(); },
        });
  };
}

function copy(el: HTMLElement): void {
  void navigator.clipboard?.writeText(el.dataset.copy ?? "").catch(() => {});
  el.classList.add("copied");
  window.setTimeout(() => el.classList.remove("copied"), 1100);
}

export function createHandleKey(inst: CodeModeInstance): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent): void => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    const inField = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    if (e.key === "Escape") {
      // Inner layers close first; the mode itself only on a bare Esc.
      if (t?.closest(".fs-search, .cm-bmenu") || inst.root.querySelector(".fs-menu:not(.fs-hidden)") || document.querySelector(".cm-ctx")) return;
      e.preventDefault();
      e.stopPropagation();
      if (inst.menuOpen) { inst.menuOpen = false; inst.renderExplorer(); inst.els.explorer.querySelector<HTMLElement>(".cm-qtitle")?.focus(); return; }
      if (inst.branchOpen) { inst.branchOpen = false; inst.renderExplorer(); return; }
      if (inst.phone) { stepBack(inst); return; }
      if (!inst.hooks.focusChat) inst.close();
      return;
    }
    if (inField) return;
    if (inst.surface.handleKey(e)) {
      e.stopPropagation();
      return;
    }
    if (e.key === "Backspace" && (inst.view.scope.kind === "commit" || inst.view.scope.kind === "pr")) {
      e.preventDefault();
      inst.scopeBack();
      return;
    }
    if (!t || !inst.root.contains(t)) return;
    treeKey(inst, e, t);
  };
}

/** Keyboard for focused explorer rows: Enter/Space activate, arrows move
 *  and fold, like a native tree. */
function treeKey(inst: CodeModeInstance, e: KeyboardEvent, t: HTMLElement): void {
  const row = t.closest<HTMLElement>("[data-file],[data-dir],[data-commit],[data-scope],.cm-copy,.cm-fold");
  if (!row || !inst.els.explorer.contains(row)) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    row.click();
    return;
  }
  const list = Array.from(inst.els.explorer.querySelectorAll<HTMLElement>(row.dataset.scope ? "[data-scope]" : "[data-file],[data-dir]"));
  const i = list.indexOf(row);
  if (e.key === "ArrowDown" && i >= 0) { e.preventDefault(); list[i + 1]?.focus(); }
  else if (e.key === "ArrowUp" && i >= 0) { e.preventDefault(); list[i - 1]?.focus(); }
  else if (row.dataset.dir !== undefined && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    const open = !inst.view.collapsed.has(row.dataset.dir);
    if ((e.key === "ArrowRight") !== open) { e.preventDefault(); inst.toggleDir(row.dataset.dir); }
  }
}

/** One step back through the phone's stacked screens; true if consumed. */
export function stepBack(inst: CodeModeInstance): boolean {
  if (inst.els.body.dataset.screen === "file") {
    inst.view.screen = "explorer";
    inst.showActive();
    return true;
  }
  if (inst.view.scope.kind === "commit" || inst.view.scope.kind === "pr") {
    inst.scopeBack();
    return true;
  }
  inst.close();
  return true;
}
