/**
 * The card behind the merged `git` chip: what were two popovers (branch list,
 * commit history) in one shell, plus a `branches` mode behind the branch line.
 * It fetches against the SPAWN cwd while the chip follows the LIVE one, so the
 * card is always about the chat's own repo and the drift footer names the other.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { timeAgo } from "../../shared/time";
import { PopoverShell } from "./statusbar-popover-shell";
import type { BranchEntry, CommitHistory, CommitHistoryEntry, CommitSync, GitInfo } from "../../types/ipc.generated";

const PAGE_SIZE = 30;
/** Distance from the list's bottom edge that triggers the next page. */
const LOAD_MARGIN_PX = 48;

export interface GitCardOpenOpts {
  /** The chat's own working dir. Everything in the card is about this repo. */
  cwd: string;
  /** Repo the AI has moved into, or null while it is still in `cwd`'s repo. */
  awayLabel: string | null;
  /** Refresh the chip's own counts once a push lands. */
  onPushed: () => void;
}

type Mode = "history" | "branches";

export class GitCard {
  private shell = new PopoverShell();
  private anchor: HTMLElement | null = null;
  private cwd: string | null = null;
  private awayLabel: string | null = null;
  private onPushed: (() => void) | null = null;
  private mode: Mode = "history";

  private info: GitInfo | null = null;
  private sync: CommitSync | null = null;
  private pushing = false;
  private pushError: string | null = null;
  private popEl: HTMLElement | null = null;

  private history: CommitHistoryEntry[] = [];
  private historyLoaded = false;
  private historyMore = false;
  private historyLoading = false;
  /** Increments each resetHistory() call; a page from a superseded open() can't append. */
  private historyGen = 0;

  private branches: BranchEntry[] | null = null;
  private branchFilter = "";

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, opts: GitCardOpenOpts): void {
    this.anchor = anchor;
    this.cwd = opts.cwd;
    this.awayLabel = opts.awayLabel;
    this.onPushed = opts.onPushed;
    this.mode = "history";
    this.pushing = false;
    this.pushError = null;
    this.info = null;
    this.sync = null;
    this.branches = null;
    this.branchFilter = "";
    this.resetHistory();
    this.rebuild();
    void this.loadHead();
    void this.loadPage();
  }

  close(): void {
    this.shell.close();
    this.anchor = null;
    this.cwd = null;
    this.onPushed = null;
    this.popEl = null;
    this.resetHistory();
  }

  reanchor(anchor: HTMLElement): void {
    this.anchor = anchor;
    this.shell.reanchor(anchor);
  }

  private resetHistory(): void {
    this.history = [];
    this.historyLoaded = false;
    this.historyMore = false;
    this.historyLoading = false;
    this.historyGen++;
  }

  /** Branch, upstream and ahead/behind for the chat's OWN repo. The statusbar's
   *  cached GitInfo tracks the live cwd instead, so it is unusable here the
   *  moment the AI has moved. */
  private async loadHead(): Promise<void> {
    const cwd = this.cwd;
    if (!cwd) return;
    const gen = this.historyGen;
    try {
      // Branches ride along with the head load: the branch line prints the
      // current one's upstream, and branch mode then opens already filled.
      const [info, sync, branches] = await Promise.all([
        invoke<GitInfo>("get_git_info", { cwd }),
        invoke<CommitSync>("get_commit_sync", { cwd }),
        invoke<BranchEntry[]>("get_recent_branches", { cwd }).catch(() => [] as BranchEntry[]),
      ]);
      if (this.cwd !== cwd || this.historyGen !== gen) return;
      this.info = info;
      this.sync = sync;
      this.branches = branches;
      this.rebuild();
    } catch (err) {
      console.error("[git-card] head load failed", err);
    }
  }

  private rebuild(): void {
    if (!this.anchor) return;
    // A session switch rewrites the pane's innerHTML, detaching the chip this
    // card is anchored to while an in-flight fetch is still pending. Placing
    // against a detached node measures all-zero and parks the card in the
    // window's top-left corner, so close instead.
    if (!this.anchor.isConnected) { this.close(); return; }
    this.shell.open(this.anchor, this.buildHtml(), {
      className: "sb-git-popover sb-git-card",
      wire: (el) => this.wire(el),
    });
  }

  private wire(el: HTMLElement): void {
    this.popEl = el;
    el.querySelector<HTMLElement>(".gc-branchline")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setMode("branches");
    });
    el.querySelector<HTMLElement>(".gc-back")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setMode("history");
    });
    el.querySelector<HTMLElement>(".sb-git-pop-push-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.doPush(false);
    });
    el.querySelector<HTMLElement>(".sb-git-pop-publish-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.doPush(true);
    });
    const search = el.querySelector<HTMLInputElement>(".gc-search input");
    if (search) {
      search.addEventListener("input", () => {
        this.branchFilter = search.value;
        this.paintBranchList();
      });
      search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.stopPropagation(); this.setMode("history"); }
      });
      search.focus();
    }
    const list = el.querySelector<HTMLElement>(".sb-commit-history");
    if (!list) return;
    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - LOAD_MARGIN_PX) void this.loadPage();
    });
    this.fillViewport(list);
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.rebuild();
  }

  /** Filtering repaints only the rows, so the caret position in the search box
   *  survives every keystroke. */
  private paintBranchList(): void {
    const host = this.popEl?.querySelector<HTMLElement>(".sb-git-pop-list");
    if (host) host.innerHTML = this.branchRowsHtml();
  }

  /** A page that doesn't overflow the list can never emit a scroll event, so
   *  the next page would be unreachable. clientHeight is 0 pre-layout (and in
   *  jsdom), where "not scrollable" is meaningless - skip rather than spin. */
  private fillViewport(list: HTMLElement): void {
    if (!this.historyMore || this.historyLoading) return;
    if (list.clientHeight <= 0) return;
    if (list.scrollHeight <= list.clientHeight + LOAD_MARGIN_PX) void this.loadPage();
  }

  /** Fetches the next page from `history.length`. Appends into the live list
   *  rather than rebuilding, so the scroll position that triggered it holds. */
  private async loadPage(): Promise<void> {
    if (this.historyLoading || !this.cwd) return;
    if (this.historyLoaded && !this.historyMore) return;
    const cwd = this.cwd;
    const gen = this.historyGen;
    const offset = this.history.length;
    this.historyLoading = true;
    this.paintSentinel();
    try {
      const page = await invoke<CommitHistory>("get_commit_history", { cwd, offset, limit: PAGE_SIZE });
      if (this.cwd !== cwd || this.historyGen !== gen) return; // card moved on (session switch, or reopened) mid-fetch
      this.historyLoading = false;
      this.historyMore = page.has_more;
      this.history = this.history.concat(page.entries);
      if (!this.historyLoaded) {
        this.historyLoaded = true;
        this.rebuild(); // first page replaces the loading placeholder
      } else {
        this.appendRows(page.entries);
      }
    } catch (err) {
      if (this.cwd !== cwd || this.historyGen !== gen) return;
      this.historyLoading = false;
      this.historyLoaded = true;
      this.historyMore = false;
      console.error("[git-card] get_commit_history failed", err);
      this.rebuild();
    }
  }

  private appendRows(entries: CommitHistoryEntry[]): void {
    const list = this.popEl?.querySelector<HTMLElement>(".sb-commit-history");
    if (!list) { this.rebuild(); return; }
    list.querySelector(".sb-history-sentinel")?.remove();
    list.insertAdjacentHTML("beforeend", entries.map((c) => this.rowHtml(c)).join("") + this.sentinelHtml());
    this.fillViewport(list);
  }

  private paintSentinel(): void {
    const list = this.popEl?.querySelector<HTMLElement>(".sb-commit-history");
    const sentinel = list?.querySelector<HTMLElement>(".sb-history-sentinel");
    if (!sentinel) return;
    sentinel.outerHTML = this.sentinelHtml();
  }

  private async doPush(publish: boolean): Promise<void> {
    if (this.pushing || !this.cwd) return;
    const cwd = this.cwd;
    this.pushing = true;
    this.pushError = null;
    this.rebuild();
    try {
      await invoke<void>("push_commits", { cwd, publish });
      const fresh = await invoke<CommitSync>("get_commit_sync", { cwd });
      if (this.cwd !== cwd) return; // card moved on (session switch) mid-push
      this.sync = fresh;
      this.pushing = false;
      this.onPushed?.();
      void this.loadHead();
      // Every row that was unpushed is now pushed - refetch instead of patching.
      this.resetHistory();
      this.rebuild();
      void this.loadPage();
    } catch (e) {
      if (this.cwd !== cwd) return;
      this.pushing = false;
      this.pushError = e instanceof Error ? e.message : String(e);
      this.rebuild();
    }
  }

  private repoLabel(): string {
    return this.info?.repo ?? (this.cwd ? this.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? "" : "");
  }

  private rowHtml(c: CommitHistoryEntry): string {
    const state = c.pushed ? "pushed" : "unpushed";
    const icon = c.pushed ? "ph-check" : "ph-arrow-up";
    const age = c.timestamp ? timeAgo(new Date(Number(c.timestamp) * 1000).toISOString()) : "";
    const title = c.pushed ? "Pushed to upstream" : "Not pushed yet";
    return `<div class="sb-git-pop-commit sb-history-row ${state}" title="${title}">`
      + `<i class="ph ${icon} sb-history-mark"></i>`
      + `<span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span>`
      + `<span class="sb-git-pop-msg">${escapeHtml(c.message)}</span>`
      + `<span class="sb-history-age">${escapeHtml(age)}</span></div>`;
  }

  private sentinelHtml(): string {
    if (this.historyLoading) {
      return `<div class="sb-history-sentinel loading"><i class="ph ph-spinner-gap sb-git-pop-spin"></i></div>`;
    }
    if (this.historyMore) return `<div class="sb-history-sentinel"></div>`;
    return `<div class="sb-history-sentinel end">end of history</div>`;
  }

  private historyHtml(): string {
    if (!this.historyLoaded) {
      return `<div class="sb-git-pop-empty"><i class="ph ph-spinner-gap sb-git-pop-spin"></i> Loading commits&hellip;</div>`;
    }
    if (this.history.length === 0) {
      return `<div class="sb-git-pop-empty">No commits on this branch yet</div>`;
    }
    const rows = this.history.map((c) => this.rowHtml(c)).join("");
    return `<div class="sb-git-pop-list sb-commit-history">${rows}${this.sentinelHtml()}</div>`;
  }

  private branchLineHtml(): string {
    const branch = this.info?.branch;
    if (!branch) return "";
    const upstream = this.branches?.find((b) => b.current)?.upstream ?? null;
    const up = this.sync?.has_upstream === false
      ? `<span class="up no-upstream">no upstream</span>`
      : upstream ? `<span class="up">${escapeHtml(upstream)}</span>` : "";
    return `<div class="gc-branchline" role="button" tabindex="0" title="Show branches">`
      + `<i class="ph ph-git-branch lead"></i>`
      + `<span class="bname">${escapeHtml(branch)}</span>${up}`
      + `<i class="ph ph-caret-down caret"></i></div>`;
  }

  /** Only appears while the AI is somewhere else. The card above it has already
   *  said everything about the chat's own repo, so the caveat reads last. */
  private driftFootHtml(): string {
    if (!this.awayLabel) return "";
    return `<div class="gc-away-foot"><i class="ph ph-arrow-bend-up-right"></i>`
      + `<span>Claude is in ${escapeHtml(this.awayLabel)}</span></div>`;
  }

  private syncSectionsHtml(): string {
    const sync = this.sync;
    if (!sync) return "";
    const parts: string[] = [];
    if (!sync.has_upstream) {
      const spin = this.pushing
        ? `<i class="ph ph-spinner-gap sb-git-pop-spin"></i> Publishing&hellip;`
        : `<i class="ph ph-cloud-arrow-up"></i> Publish${this.info?.branch ? ` "${escapeHtml(this.info.branch)}"` : " branch"}`;
      parts.push(`<div class="sb-git-pop-empty">No upstream configured for this branch</div>
        <div class="sb-git-pop-publish"><button class="sb-git-pop-publish-btn"${this.pushing ? " disabled" : ""}>${spin}</button></div>`);
    } else if (sync.ahead.length > 0) {
      const pushBtn = this.pushing
        ? `<button class="sb-git-pop-push-btn" disabled><i class="ph ph-spinner-gap sb-git-pop-spin"></i></button>`
        : `<button class="sb-git-pop-push-btn"><i class="ph ph-cloud-arrow-up"></i> Push</button>`;
      parts.push(`<div class="sb-git-pop-section ahead"><i class="ph ph-arrow-up"></i>Yours, not pushed <span class="sb-git-pop-count">${sync.ahead.length}</span>${pushBtn}</div>`);
    } else if (sync.behind.length === 0) {
      parts.push(`<div class="sb-git-pop-section synced"><i class="ph ph-check-circle"></i>Up to date with upstream</div>`);
    }
    if (sync.behind.length > 0) {
      const rows = sync.behind.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      parts.push(`<div class="sb-git-pop-section behind"><i class="ph ph-arrow-down"></i>Incoming <span class="sb-git-pop-count">${sync.behind.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    return parts.join("");
  }

  private branchRowsHtml(): string {
    const all = this.branches;
    if (all === null) return `<div class="sb-git-pop-empty"><i class="ph ph-spinner-gap sb-git-pop-spin"></i> Loading branches&hellip;</div>`;
    const q = this.branchFilter.trim().toLowerCase();
    const shown = q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
    if (shown.length === 0) {
      return `<div class="sb-git-pop-empty">${all.length === 0 ? "No branches found" : "No branch matches that"}</div>`;
    }
    return shown.map((b) => {
      const check = b.current ? `<i class="ph ph-check sb-git-pop-check"></i>` : `<span class="sb-git-pop-check-pad"></span>`;
      const sha = b.short_sha ? `<span class="sb-git-pop-sha">${escapeHtml(b.short_sha)}</span>` : "";
      const up = b.upstream ? `<span class="sb-git-pop-upstream">${escapeHtml(b.upstream)}</span>` : "";
      return `<div class="sb-git-pop-row${b.current ? " current" : ""}">${check}<span class="sb-git-pop-name">${escapeHtml(b.name)}</span>${sha}${up}</div>`;
    }).join("");
  }

  private buildHtml(): string {
    const repo = escapeHtml(this.repoLabel());
    if (this.mode === "branches") {
      return `<div class="sb-git-pop-header gc-back" role="button" tabindex="0"><i class="ph ph-arrow-left"></i>Branches${repo ? ` &mdash; ${repo}` : ""}</div>`
        + `<div class="gc-search"><i class="ph ph-magnifying-glass"></i><input value="${escapeHtml(this.branchFilter)}" spellcheck="false" placeholder="Filter branches" aria-label="Filter branches"></div>`
        + `<div class="sb-git-pop-list">${this.branchRowsHtml()}</div>`
        + `<div class="gc-hint">Esc to go back</div>`;
    }
    const errorHtml = this.pushError
      ? `<div class="sb-git-pop-error"><i class="ph ph-warning"></i>${escapeHtml(this.pushError)}</div>`
      : "";
    return `<div class="sb-git-pop-header"><i class="ph ph-folder"></i>${repo || "This repo"}</div>`
      + this.branchLineHtml()
      + this.syncSectionsHtml()
      + this.historyHtml()
      + errorHtml
      + this.driftFootHtml();
  }
}
