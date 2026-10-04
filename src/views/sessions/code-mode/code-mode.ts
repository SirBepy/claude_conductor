// Code mode: one place to read code and review changes. A mode the chat view
// enters and leaves (Esc, or the back pill), covering the chat list and the
// chat with a file explorer on the left and file tabs + diff on the right.
// It can also live in its own OS window (popout.ts). Read-only.

import { escapeHtml } from "../../../shared/escape-html";
import { basename } from "../../../shared/path-utils";
import { invoke } from "../../../shared/ipc";
import { isRemote } from "../../../shared/transport";
import { registerOverlayBack } from "../../../shared/back-button";
import { createFileSurface, type FileSurfaceHandle, type SurfaceFile } from "../../../shared/chat/file-surface";
import type { FileEditView } from "../../../shared/chat/file-edits";
import type { CodeModeTarget } from "../../../shared/chat/code-mode-bridge";
import { BranchSwitcher } from "./branch-switcher";
import { allDirs, repoRelative, type FileStatus } from "./tree";
import { explorerHtml, type ExplorerModel } from "./explorer-html";
import { renderPrDescription } from "./pr-description";
import { openTreeContextMenu, closeTreeContextMenu } from "./context-menu";
import {
  chatFiles,
  loadGitState,
  loadScope,
  plainSurface,
  type BaseScope,
  type GitState,
  type ScopeData,
  type ScopeRef,
} from "./data";
import "./code-mode.css";

/** The chat a Code mode instance is about. Supplied by whichever view hosts
 *  the chat (the sessions view, history, the pop-out window's proxy). */
export interface CodeModeChat {
  /** Per-chat state key: open tabs and scope survive leaving and re-entering. */
  key: string;
  sessionId: string | null;
  cwd: string;
  /** Element Code mode covers: its other children hide while it is open. */
  layout: HTMLElement;
  title(): string;
  busy(): boolean;
  latestLine(): string;
  edits(): FileEditView[];
  /** Put `@path` in the chat's message box; null where there is none. */
  mention: ((relPath: string) => void) | null;
  /** Called after a push / pull / checkout so the chat's git chip refreshes. */
  onGitChanged?: () => void;
}

export type { CodeModeTarget };

interface Tab {
  path: string;
  status: FileStatus | null;
  /** Opened inside a commit / PR, where an M badge says nothing. */
  inCommit: boolean;
  surface: SurfaceFile;
}

const DESC_TAB = "\u0000description";

interface ViewState {
  scope: ScopeRef;
  /** Where ← returns to from an opened commit or PR. */
  prevScope: BaseScope;
  tabs: Tab[];
  active: string | null;
  collapsed: Set<string>;
  commitsOpen: boolean;
  desc: HTMLTemplateElement | null;
  /** Phone only: which stacked screen shows. */
  screen: "explorer" | "file";
}

const views = new Map<string, ViewState>();

function viewFor(key: string): ViewState {
  let v = views.get(key);
  if (!v) {
    v = { scope: { kind: "chat" }, prevScope: "chat", tabs: [], active: null, collapsed: new Set(), commitsOpen: false, desc: null, screen: "explorer" };
    views.set(key, v);
  }
  return v;
}

export interface CodeModeHooks {
  /** Present only where Code mode can move to / from its own OS window. */
  popOut?: () => void;
  dock?: () => void;
  /** The back pill's action when it doesn't simply leave the mode. */
  focusChat?: () => void;
}

let current: CodeModeInstance | null = null;

export function isCodeModeOpen(): boolean {
  return current !== null;
}

export function currentCodeModeKey(): string | null {
  return current?.chat.key ?? null;
}

/** Snapshot of a chat's Code mode state, handed across windows on pop-out
 *  and dock so tabs and scope come along. */
export interface ViewSnapshot {
  scope: ScopeRef;
  prevScope: BaseScope;
  tabs: { path: string; status: FileStatus | null; inCommit: boolean }[];
  active: string | null;
  commitsOpen: boolean;
}

export function snapshotView(key: string): ViewSnapshot | null {
  const v = views.get(key);
  if (!v) return null;
  return {
    scope: v.scope,
    prevScope: v.prevScope,
    tabs: v.tabs.filter((t) => t.path !== DESC_TAB).map((t) => ({ path: t.path, status: t.status, inCommit: t.inCommit })),
    active: v.active === DESC_TAB ? null : v.active,
    commitsOpen: v.commitsOpen,
  };
}

/** Seeds a chat's state from another window's snapshot. Tab sources are
 *  rebuilt from the scope once it loads; until then a tab reads the file as
 *  it is on disk. */
export function restoreView(key: string, cwd: string, snap: ViewSnapshot): void {
  const v = viewFor(key);
  v.scope = snap.scope.kind === "pr" ? { kind: snap.prevScope } : snap.scope;
  v.prevScope = snap.prevScope;
  v.tabs = snap.tabs.map((t) => ({ ...t, surface: plainSurface(cwd, t.path) }));
  v.active = snap.active;
  v.commitsOpen = snap.commitsOpen;
}

export function openCodeMode(chat: CodeModeChat, target: CodeModeTarget = { kind: "default" }, hooks: CodeModeHooks = {}): void {
  if (current && current.chat.key !== chat.key) current.close();
  if (!current) current = new CodeModeInstance(chat, hooks);
  current.apply(target);
}

export function closeCodeMode(): void {
  current?.close();
}

class CodeModeInstance {
  readonly root: HTMLElement;
  private readonly view: ViewState;
  private readonly els: {
    pill: HTMLButtonElement;
    explorer: HTMLElement;
    tabrow: HTMLElement;
    tools: HTMLElement;
    desc: HTMLElement;
    surfaceHost: HTMLElement;
    empty: HTMLElement;
    body: HTMLElement;
  };
  private surface: FileSurfaceHandle;
  private data: ScopeData | null = null;
  private git: GitState | null = null;
  private menuOpen = false;
  private menuCounts: ExplorerModel["menuCounts"] = {};
  private branchOpen = false;
  private branchSwitcher: BranchSwitcher | null = null;
  private gitBusy: "push" | "pull" | null = null;
  private gitError: string | null = null;
  private loadGen = 0;
  private editsSeen = -1;
  private pillTimer: number;
  private readonly phone = isRemote();
  private disposeBack: (() => void) | null = null;
  private readonly onKeydown = (e: KeyboardEvent) => this.handleKey(e);
  private readonly onDocClick = (e: MouseEvent) => this.handleDocClick(e);

  constructor(readonly chat: CodeModeChat, private readonly hooks: CodeModeHooks) {
    this.view = viewFor(chat.key);
    const root = document.createElement("section");
    root.className = `code-mode${this.phone ? " cm-phone" : ""}`;
    root.setAttribute("aria-label", "Code mode");
    const trail = hooks.dock
      ? `<button class="cm-ib" data-act="dock" title="Put Code mode back into the chat window (Ctrl+Shift+O)" aria-label="Dock back"><i class="ph ph-arrow-square-in"></i></button>`
      : hooks.popOut
        ? `<button class="cm-ib" data-act="popout" title="Open Code mode in its own window (Ctrl+Shift+O)" aria-label="Pop out"><i class="ph ph-arrow-square-out"></i></button>`
        : "";
    root.innerHTML = `<div class="cm-modebar">`
      + `<button class="cm-backchat" data-act="back"><i class="ph ${hooks.dock ? "ph-chat-circle" : "ph-arrow-left"} cm-bc-ic"></i>`
      + `<span class="cm-bc-title"></span><span class="cm-bc-sep"></span><span class="cm-live"></span><span class="cm-bc-text"></span></button>`
      + `<span class="grow"></span>${trail}</div>`
      + `<div class="cm-body">`
      + `<section class="cm-explorer"></section>`
      + `<section class="cm-editor">`
      + `<div class="cm-tabs"><button class="cm-ib cm-files-back" data-act="screen-explorer" aria-label="Back to files"><i class="ph ph-arrow-left"></i></button><div class="cm-tabrow" role="tablist"></div><div class="cm-tools"></div></div>`
      + `<div class="cm-desc pr-modal-body-content" hidden></div>`
      + `<div class="cm-surface"></div>`
      + `<div class="cm-empty"><i class="ph ph-tree-structure"></i><p>Pick a file on the left.</p></div>`
      + `</section></div>`;
    this.root = root;
    this.els = {
      pill: root.querySelector(".cm-backchat")!,
      explorer: root.querySelector(".cm-explorer")!,
      tabrow: root.querySelector(".cm-tabrow")!,
      tools: root.querySelector(".cm-tools")!,
      desc: root.querySelector(".cm-desc")!,
      surfaceHost: root.querySelector(".cm-surface")!,
      empty: root.querySelector(".cm-empty")!,
      body: root.querySelector(".cm-body")!,
    };
    this.surface = createFileSurface(this.els.surfaceHost, { defaultView: "diff", toolsHost: this.els.tools });
    chat.layout.appendChild(root);
    chat.layout.classList.add("code-mode-on");
    // Nothing typed while reading code should land in the hidden composer.
    (document.activeElement as HTMLElement | null)?.blur?.();
    root.addEventListener("click", (e) => this.handleClick(e));
    root.addEventListener("dblclick", (e) => this.handleDblClick(e));
    root.addEventListener("auxclick", (e) => this.handleAuxClick(e));
    root.addEventListener("contextmenu", (e) => this.handleContextMenu(e));
    document.addEventListener("keydown", this.onKeydown, true);
    document.addEventListener("click", this.onDocClick);
    this.pillTimer = window.setInterval(() => this.tick(), 1000);
    // The phone's hardware back steps file -> explorer -> chat, like the
    // stacked screens it walks back through.
    if (this.phone) this.disposeBack = registerOverlayBack(() => this.stepBack());
    this.updatePill();
    void this.loadGit();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  apply(target: CodeModeTarget): void {
    const v = this.view;
    switch (target.kind) {
      case "default":
        break;
      case "scope":
        v.scope = { kind: target.scope };
        v.prevScope = target.scope;
        if (target.commitsOpen) v.commitsOpen = true;
        break;
      case "file": {
        const rel = repoRelative(this.chat.cwd, target.path);
        if (v.scope.kind === "commit" || v.scope.kind === "pr") v.scope = { kind: v.prevScope };
        this.pendingOpen = rel;
        break;
      }
      case "commit":
        this.enterScope({ kind: "commit", sha: target.sha, title: target.title }, true);
        v.commitsOpen = true;
        return;
      case "pr":
        v.desc = target.desc;
        this.els.desc.dataset.rendered = "";
        if (target.desc) this.upsertTab({ path: DESC_TAB, status: null, inCommit: true, surface: plainSurface(this.chat.cwd, "") }, true);
        this.enterScope({ kind: "pr", title: target.title, commits: target.commits }, false);
        return;
    }
    this.reload();
  }

  /** A path to open once the current scope finishes loading. */
  private pendingOpen: string | null = null;
  private openFirstOnLoad = false;

  close(): void {
    if (current === this) current = null;
    window.clearInterval(this.pillTimer);
    this.disposeBack?.();
    document.removeEventListener("keydown", this.onKeydown, true);
    document.removeEventListener("click", this.onDocClick);
    closeTreeContextMenu();
    this.branchSwitcher?.unmount();
    this.surface.destroy();
    this.root.remove();
    this.chat.layout.classList.remove("code-mode-on");
  }

  reload(): void {
    void this.loadScope();
    void this.loadGit();
  }

  private enterScope(scope: ScopeRef, openFirst: boolean): void {
    const v = this.view;
    if (v.scope.kind !== "commit" && v.scope.kind !== "pr") v.prevScope = v.scope.kind;
    v.scope = scope;
    this.menuOpen = false;
    this.openFirstOnLoad = openFirst;
    void this.loadScope();
  }

  private async loadScope(): Promise<void> {
    const gen = ++this.loadGen;
    this.data = null;
    this.renderExplorer();
    const edits = this.chat.edits();
    this.editsSeen = edits.length;
    const data = await loadScope({ cwd: this.chat.cwd, edits }, this.view.scope);
    if (gen !== this.loadGen || current !== this) return;
    this.data = data;
    this.refreshTabSources();
    if (this.openFirstOnLoad) {
      this.openFirstOnLoad = false;
      const first = data.paths.slice().sort((a, b) => a.localeCompare(b))[0];
      if (first) this.openPath(first);
    }
    if (this.pendingOpen) {
      const p = this.pendingOpen;
      this.pendingOpen = null;
      this.openPath(p);
    }
    this.renderExplorer();
    this.renderTabs();
  }

  private async loadGit(): Promise<void> {
    const git = await loadGitState(this.chat.cwd);
    if (current !== this) return;
    this.git = git;
    this.renderExplorer();
  }

  /** Once a scope loads, an open tab whose file is in it shows that scope's
   *  diff; one that isn't keeps the source it was opened with. */
  private refreshTabSources(): void {
    const changed = this.data?.changed;
    if (!changed) return;
    const inCommit = this.view.scope.kind === "commit" || this.view.scope.kind === "pr";
    for (const t of this.view.tabs) {
      const f = changed.get(t.path);
      if (!f) continue;
      t.surface = f.surface;
      t.status = f.status;
      t.inCommit = inCommit;
    }
    this.showActive();
  }

  private tick(): void {
    this.updatePill();
    if (this.view.scope.kind === "chat" && this.chat.edits().length !== this.editsSeen) void this.loadScope();
  }

  // ── tabs ──────────────────────────────────────────────────────────────

  private upsertTab(tab: Tab, activate: boolean): void {
    const v = this.view;
    const existing = v.tabs.find((t) => t.path === tab.path);
    if (existing) Object.assign(existing, tab);
    else if (tab.path === DESC_TAB) v.tabs.unshift(tab);
    else v.tabs.push(tab);
    if (activate) v.active = tab.path;
  }

  private openPath(path: string): void {
    const f = this.data?.changed.get(path);
    const inCommit = this.view.scope.kind === "commit" || this.view.scope.kind === "pr";
    this.upsertTab({ path, status: f?.status ?? null, inCommit, surface: f?.surface ?? plainSurface(this.chat.cwd, path) }, true);
    this.view.screen = "file";
    this.renderExplorer();
    this.renderTabs();
    this.showActive();
  }

  private closeTab(path: string): void {
    const v = this.view;
    const i = v.tabs.findIndex((t) => t.path === path);
    if (i < 0) return;
    v.tabs.splice(i, 1);
    if (v.active === path) v.active = (v.tabs[i] ?? v.tabs[i - 1])?.path ?? null;
    if (!v.active) v.screen = "explorer";
    this.renderTabs();
    this.renderExplorer();
    this.showActive();
  }

  private activate(path: string): void {
    this.view.active = path;
    this.view.screen = "file";
    this.renderTabs();
    this.renderExplorer();
    this.showActive();
  }

  private showActive(): void {
    const v = this.view;
    const tab = v.tabs.find((t) => t.path === v.active) ?? null;
    const isDesc = tab?.path === DESC_TAB;
    this.els.desc.hidden = !isDesc;
    this.els.surfaceHost.hidden = !tab || isDesc;
    this.els.tools.hidden = !tab || isDesc;
    this.els.empty.hidden = !!tab;
    this.els.body.dataset.screen = tab ? v.screen : "explorer";
    if (isDesc && v.desc) {
      if (this.els.desc.dataset.rendered !== "1") {
        renderPrDescription(this.els.desc, v.desc);
        this.els.desc.dataset.rendered = "1";
      }
    } else if (tab) {
      this.surface.show(tab.surface);
    }
  }

  private renderTabs(): void {
    const v = this.view;
    this.els.tabrow.innerHTML = v.tabs.map((t) => {
      const on = t.path === v.active;
      if (t.path === DESC_TAB) {
        return `<button class="cm-tab cm-desc-tab${on ? " on" : ""}" role="tab" aria-selected="${on}" data-tab="${escapeHtml(t.path)}" title="PR description"><i class="ph ph-article"></i>Description</button>`;
      }
      const badge = t.status && !(t.inCommit && t.status === "M")
        ? `<span class="pr-file-status st-${t.status}">${t.status}</span>`
        : `<i class="ph ph-file"></i>`;
      return `<button class="cm-tab${on ? " on" : ""}" role="tab" aria-selected="${on}" data-tab="${escapeHtml(t.path)}" title="${escapeHtml(t.path)}">`
        + `${badge}<span class="cm-tab-name">${escapeHtml(basename(t.path))}</span>`
        + `<span class="cm-x" role="button" aria-label="Close ${escapeHtml(basename(t.path))}" data-close="${escapeHtml(t.path)}"><i class="ph ph-x"></i></span></button>`;
    }).join("");
    this.els.tabrow.querySelector(".cm-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ── explorer ──────────────────────────────────────────────────────────

  private model(): ExplorerModel {
    return {
      scope: this.view.scope,
      data: this.data,
      collapsed: this.view.collapsed,
      activePath: this.view.active,
      menuOpen: this.menuOpen,
      menuCounts: this.menuCounts,
      git: this.git,
      commitsOpen: this.view.commitsOpen,
      branchOpen: this.branchOpen,
      gitBusy: this.gitBusy,
      gitError: this.gitError,
    };
  }

  private renderExplorer(): void {
    const ex = this.els.explorer;
    // Keep the tree's scroll and the focused row across a repaint.
    const tree = ex.querySelector<HTMLElement>(".cm-tree");
    const scroll = tree?.scrollTop ?? 0;
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-file],[data-dir],[data-commit]");
    const focusKey = focused && ex.contains(focused)
      ? (focused.dataset.file ? `[data-file="${CSS.escape(focused.dataset.file)}"]` : focused.dataset.dir ? `[data-dir="${CSS.escape(focused.dataset.dir)}"]` : `[data-commit="${CSS.escape(focused.dataset.commit!)}"]`)
      : null;
    this.branchSwitcher?.unmount();
    ex.innerHTML = explorerHtml(this.model());
    const newTree = ex.querySelector<HTMLElement>(".cm-tree");
    if (newTree) newTree.scrollTop = scroll;
    if (focusKey) ex.querySelector<HTMLElement>(focusKey)?.focus();
    const bmenu = ex.querySelector<HTMLElement>(".cm-bmenu");
    if (bmenu) {
      this.branchSwitcher = new BranchSwitcher({
        cwd: this.chat.cwd,
        sessionId: this.chat.sessionId,
        onCheckedOut: () => {
          this.branchOpen = false;
          this.chat.onGitChanged?.();
          this.reload();
        },
        onClose: () => {
          this.branchOpen = false;
          this.renderExplorer();
          ex.querySelector<HTMLElement>(".cm-branchbtn")?.focus();
        },
      });
      this.branchSwitcher.mount(bmenu);
    } else {
      this.branchSwitcher = null;
    }
  }

  private async openMenu(): Promise<void> {
    this.menuOpen = true;
    this.menuCounts = { chat: chatFiles({ cwd: this.chat.cwd, edits: this.chat.edits() }).size, unpushed: null, uncommitted: null };
    this.renderExplorer();
    this.els.explorer.querySelector<HTMLElement>(".cm-mi[aria-checked=true]")?.focus();
    const counts = await Promise.all((["unpushed", "uncommitted"] as const).map(async (k) => {
      const d = await loadScope({ cwd: this.chat.cwd, edits: [] }, { kind: k });
      return [k, d.error ? 0 : d.changed.size] as const;
    }));
    if (!this.menuOpen || current !== this) return;
    for (const [k, n] of counts) this.menuCounts[k] = n;
    this.renderExplorer();
    this.els.explorer.querySelector<HTMLElement>(".cm-mi[aria-checked=true]")?.focus();
  }

  private setScope(kind: BaseScope): void {
    this.menuOpen = false;
    this.view.scope = { kind };
    this.view.prevScope = kind;
    void this.loadScope();
    this.els.explorer.querySelector<HTMLElement>(".cm-qtitle")?.focus();
  }

  private scopeBack(): void {
    const v = this.view;
    if (v.scope.kind !== "commit" && v.scope.kind !== "pr") return;
    v.scope = { kind: v.prevScope };
    void this.loadScope();
  }

  private toggleDir(dir: string): void {
    const c = this.view.collapsed;
    if (c.has(dir)) c.delete(dir);
    else c.add(dir);
    this.renderExplorer();
  }

  private async runGit(kind: "push" | "pull"): Promise<void> {
    if (this.gitBusy) return;
    const cwd = this.chat.cwd;
    this.gitBusy = kind;
    this.gitError = null;
    this.renderExplorer();
    try {
      if (kind === "push") await invoke<void>("push_commits", { cwd, publish: !this.git?.sync?.has_upstream });
      else await invoke<void>("pull_commits", { cwd });
      this.chat.onGitChanged?.();
    } catch (e) {
      this.gitError = e instanceof Error ? e.message : String(e);
    }
    this.gitBusy = null;
    if (current !== this) return;
    this.reload();
  }

  // ── back pill ─────────────────────────────────────────────────────────

  private updatePill(): void {
    const busy = this.chat.busy();
    const title = this.chat.title() || "Chat";
    const line = this.chat.latestLine();
    const p = this.els.pill;
    p.querySelector(".cm-bc-title")!.textContent = title;
    p.querySelector(".cm-bc-text")!.textContent = line;
    const live = p.querySelector<HTMLElement>(".cm-live")!;
    live.classList.toggle("on", busy);
    live.title = busy ? "Claude is writing" : "Idle";
    p.title = this.hooks.focusChat ? "Bring the chat window to the front" : "Back to the chat (Esc)";
    p.setAttribute("aria-label", `${this.hooks.focusChat ? "Show" : "Back to"} ${title}${busy ? ", Claude is writing" : ""}`);
  }

  /** One step back through the phone's stacked screens; true if consumed. */
  private stepBack(): boolean {
    if (this.els.body.dataset.screen === "file") {
      this.view.screen = "explorer";
      this.showActive();
      return true;
    }
    if (this.view.scope.kind === "commit" || this.view.scope.kind === "pr") {
      this.scopeBack();
      return true;
    }
    this.close();
    return true;
  }

  private leave(): void {
    if (this.hooks.focusChat) this.hooks.focusChat();
    else this.close();
  }

  // ── events ────────────────────────────────────────────────────────────

  private handleClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const copy = t.closest<HTMLElement>(".cm-copy");
    if (copy) {
      this.copy(copy);
      return;
    }
    if (t.closest(".cm-bmenu")) return;
    const closeBtn = t.closest<HTMLElement>("[data-close]");
    if (closeBtn) {
      e.stopPropagation();
      this.closeTab(closeBtn.dataset.close!);
      return;
    }
    const el = t.closest<HTMLElement>("[data-act],[data-scope],[data-dir],[data-file],[data-commit],[data-tab]");
    if (!el) return;
    const d = el.dataset;
    if (d.scope) this.setScope(d.scope as BaseScope);
    else if (d.dir !== undefined) this.toggleDir(d.dir);
    else if (d.file) this.openPath(d.file);
    else if (d.commit) this.enterScope({ kind: "commit", sha: d.commit, title: d.title ?? d.commit }, true);
    else if (d.tab) this.activate(d.tab);
    else this.act(d.act!, el);
  }

  private act(act: string, el: HTMLElement): void {
    switch (act) {
      case "back": this.leave(); break;
      case "popout": this.hooks.popOut?.(); break;
      case "dock": this.hooks.dock?.(); break;
      case "menu":
        if (this.menuOpen) { this.menuOpen = false; this.renderExplorer(); } else void this.openMenu();
        break;
      case "scope-back": this.scopeBack(); break;
      case "fold":
        this.view.commitsOpen = !this.view.commitsOpen;
        this.branchOpen = false;
        this.renderExplorer();
        this.els.explorer.querySelector<HTMLElement>(".cm-fold")?.focus();
        break;
      case "branch":
        this.branchOpen = !this.branchOpen;
        this.renderExplorer();
        break;
      case "push": void this.runGit("push"); break;
      case "pull": void this.runGit("pull"); break;
      case "screen-explorer":
        this.view.screen = "explorer";
        this.showActive();
        break;
      default:
        void el;
    }
  }

  private handleDblClick(e: MouseEvent): void {
    // Double-click empty tab-row space: nothing to pin, tabs are already
    // permanent; swallow so the text selection doesn't flash.
    if ((e.target as HTMLElement).closest(".cm-tabrow")) e.preventDefault();
  }

  private handleAuxClick(e: MouseEvent): void {
    if (e.button !== 1) return;
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".cm-tab[data-tab]");
    if (tab && tab.dataset.tab !== DESC_TAB) {
      e.preventDefault();
      this.closeTab(tab.dataset.tab!);
    }
  }

  private handleDocClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (this.menuOpen && !t.closest(".cm-scope-menu, .cm-qtitle")) {
      this.menuOpen = false;
      this.renderExplorer();
    }
    if (this.branchOpen && !t.closest(".cm-bmenu, .cm-branchbtn")) {
      this.branchOpen = false;
      this.renderExplorer();
    }
  }

  private handleContextMenu(e: MouseEvent): void {
    const tree = (e.target as HTMLElement).closest(".cm-tree");
    if (!tree) return;
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-file]");
    const cwd = this.chat.cwd.replace(/[\\/]+$/, "");
    openTreeContextMenu(e.clientX, e.clientY, row?.dataset.file
      ? {
          kind: "file",
          relPath: row.dataset.file,
          absPath: `${cwd}/${row.dataset.file}`,
          onMention: this.chat.mention
            ? (rel) => {
                this.chat.mention!(rel);
                // In the chat's own window the message box is under this mode.
                if (!this.hooks.focusChat) this.close();
              }
            : null,
        }
      : {
          kind: "space",
          onExpandAll: () => { this.view.collapsed = new Set(); this.renderExplorer(); },
          onCollapseAll: () => { this.view.collapsed = allDirs(this.data?.paths ?? []); this.renderExplorer(); },
        });
  }

  private copy(el: HTMLElement): void {
    void navigator.clipboard?.writeText(el.dataset.copy ?? "").catch(() => {});
    el.classList.add("copied");
    window.setTimeout(() => el.classList.remove("copied"), 1100);
  }

  private handleKey(e: KeyboardEvent): void {
    const t = e.target instanceof HTMLElement ? e.target : null;
    const inField = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    if (e.key === "Escape") {
      // Inner layers close first; the mode itself only on a bare Esc.
      if (t?.closest(".fs-search, .cm-bmenu") || this.root.querySelector(".fs-menu:not(.fs-hidden)") || document.querySelector(".cm-ctx")) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.menuOpen) { this.menuOpen = false; this.renderExplorer(); this.els.explorer.querySelector<HTMLElement>(".cm-qtitle")?.focus(); return; }
      if (this.branchOpen) { this.branchOpen = false; this.renderExplorer(); return; }
      if (this.phone) { this.stepBack(); return; }
      if (!this.hooks.focusChat) this.close();
      return;
    }
    if (inField) return;
    if (this.surface.handleKey(e)) {
      e.stopPropagation();
      return;
    }
    if (e.key === "Backspace" && (this.view.scope.kind === "commit" || this.view.scope.kind === "pr")) {
      e.preventDefault();
      this.scopeBack();
      return;
    }
    if (!t || !this.root.contains(t)) return;
    this.treeKey(e, t);
  }

  /** Keyboard for focused explorer rows: Enter/Space activate, arrows move
   *  and fold, like a native tree. */
  private treeKey(e: KeyboardEvent, t: HTMLElement): void {
    const row = t.closest<HTMLElement>("[data-file],[data-dir],[data-commit],[data-scope],.cm-copy,.cm-fold");
    if (!row || !this.els.explorer.contains(row)) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
      return;
    }
    const list = Array.from(this.els.explorer.querySelectorAll<HTMLElement>(row.dataset.scope ? "[data-scope]" : "[data-file],[data-dir]"));
    const i = list.indexOf(row);
    if (e.key === "ArrowDown" && i >= 0) { e.preventDefault(); list[i + 1]?.focus(); }
    else if (e.key === "ArrowUp" && i >= 0) { e.preventDefault(); list[i - 1]?.focus(); }
    else if (row.dataset.dir !== undefined && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const open = !this.view.collapsed.has(row.dataset.dir);
      if ((e.key === "ArrowRight") !== open) { e.preventDefault(); this.toggleDir(row.dataset.dir); }
    }
  }
}
