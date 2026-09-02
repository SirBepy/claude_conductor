/**
 * Ahead/behind commits statusline chip + popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 *
 * The body is one merged branch history: unpushed commits carry an accent bar,
 * pushed ones a muted check. Pages append into the live list, since a shell
 * rebuild would reset the scroll position that asked for them.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { timeAgo } from "../../shared/time";
import { PopoverShell } from "./statusbar-popover-shell";

export interface CommitEntry { short_sha: string; message: string; }
export interface CommitSync { ahead: CommitEntry[]; behind: CommitEntry[]; has_upstream: boolean; }
export interface HistoryEntry { short_sha: string; message: string; pushed: boolean; timestamp: number; }
export interface CommitHistory { entries: HistoryEntry[]; has_more: boolean; has_upstream: boolean; }

const PAGE_SIZE = 30;
/** Distance from the list's bottom edge that triggers the next page. */
const LOAD_MARGIN_PX = 48;

export class CommitsPopover {
  private shell = new PopoverShell();
  private anchor: HTMLElement | null = null;
  private cwd: string | null = null;
  private sync: CommitSync | null = null;
  private branch: string | null = null;
  private onPushed: (() => void) | null = null;
  private pushing = false;
  private pushError: string | null = null;
  private popEl: HTMLElement | null = null;
  private history: HistoryEntry[] = [];
  private historyLoaded = false;
  private historyMore = false;
  private historyLoading = false;

  get isOpen(): boolean { return this.shell.isOpen; }

  /** `branch` labels the publish action; `onPushed` lets the statusbar refresh
   *  the chip's own ahead/behind counts once a push lands. */
  open(anchor: HTMLElement, cwd: string, sync: CommitSync, branch: string | null, onPushed: () => void): void {
    this.anchor = anchor;
    this.cwd = cwd;
    this.sync = sync;
    this.branch = branch;
    this.onPushed = onPushed;
    this.pushing = false;
    this.pushError = null;
    this.resetHistory();
    this.rebuild();
    void this.loadPage();
  }

  close(): void {
    this.shell.close();
    this.anchor = null;
    this.cwd = null;
    this.sync = null;
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
  }

  private rebuild(): void {
    if (!this.anchor) return;
    this.shell.open(this.anchor, this.buildHtml(), {
      className: "sb-git-popover sb-commits-popover",
      wire: (el) => this.wire(el),
    });
  }

  private wire(el: HTMLElement): void {
    this.popEl = el;
    el.querySelector<HTMLElement>(".sb-git-pop-push-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.doPush(false);
    });
    el.querySelector<HTMLElement>(".sb-git-pop-publish-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.doPush(true);
    });
    const list = el.querySelector<HTMLElement>(".sb-commit-history");
    if (!list) return;
    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - LOAD_MARGIN_PX) void this.loadPage();
    });
    this.fillViewport(list);
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
    const offset = this.history.length;
    this.historyLoading = true;
    this.paintSentinel();
    try {
      const page = await invoke<CommitHistory>("get_commit_history", { cwd, offset, limit: PAGE_SIZE });
      if (this.cwd !== cwd) return; // popover moved on (session switch) mid-fetch
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
      if (this.cwd !== cwd) return;
      this.historyLoading = false;
      this.historyLoaded = true;
      this.historyMore = false;
      console.error("[commits-popover] get_commit_history failed", err);
      this.rebuild();
    }
  }

  private appendRows(entries: HistoryEntry[]): void {
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
      if (this.cwd !== cwd) return; // popover moved on (session switch) mid-push
      this.sync = fresh;
      this.pushing = false;
      this.onPushed?.();
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

  private rowHtml(c: HistoryEntry): string {
    const state = c.pushed ? "pushed" : "unpushed";
    const icon = c.pushed ? "ph-check" : "ph-arrow-up";
    const age = c.timestamp ? timeAgo(new Date(c.timestamp * 1000).toISOString()) : "";
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

  private buildHtml(): string {
    const sync = this.sync;
    if (!sync) return `<div class="sb-git-pop-empty">Loading&hellip;</div>`;
    const errorHtml = this.pushError
      ? `<div class="sb-git-pop-error"><i class="ph ph-warning"></i>${escapeHtml(this.pushError)}</div>`
      : "";
    const parts: string[] = [];
    if (!sync.has_upstream) {
      const spin = this.pushing
        ? `<i class="ph ph-spinner-gap sb-git-pop-spin"></i> Publishing&hellip;`
        : `<i class="ph ph-cloud-arrow-up"></i> Publish${this.branch ? ` "${escapeHtml(this.branch)}"` : " branch"}`;
      parts.push(`<div class="sb-git-pop-empty">No upstream configured for this branch</div>
        <div class="sb-git-pop-publish"><button class="sb-git-pop-publish-btn"${this.pushing ? " disabled" : ""}>${spin}</button></div>`);
    } else if (sync.ahead.length > 0) {
      const pushBtn = this.pushing
        ? `<button class="sb-git-pop-push-btn" disabled><i class="ph ph-spinner-gap sb-git-pop-spin"></i></button>`
        : `<button class="sb-git-pop-push-btn"><i class="ph ph-cloud-arrow-up"></i> Push</button>`;
      parts.push(`<div class="sb-git-pop-section ahead"><i class="ph ph-arrow-up"></i>Unpushed <span class="sb-git-pop-count">${sync.ahead.length}</span>${pushBtn}</div>`);
    } else {
      parts.push(`<div class="sb-git-pop-section synced"><i class="ph ph-check-circle"></i>Up to date with upstream</div>`);
    }
    if (sync.behind.length > 0) {
      const rows = sync.behind.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      parts.push(`<div class="sb-git-pop-section behind"><i class="ph ph-arrow-down"></i>Incoming <span class="sb-git-pop-count">${sync.behind.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    parts.push(this.historyHtml());
    return parts.join("") + errorHtml;
  }
}
