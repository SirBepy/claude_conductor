/**
 * The git chip's popover: the chat's branch as a paged list of commits, pushed
 * and unpushed marked. A row opens that commit in Code mode; hovering a row
 * swaps its age for the absolute time and shows copy buttons for the hash and
 * the subject. Push, pull and branch switching live in Code mode only.
 */

import { escapeHtml } from "../../shared/escape-html";
import { timeAgo } from "../../shared/time";
import { openInCodeMode } from "../../shared/chat/code-mode-bridge";
import { PopoverShell } from "./statusbar-popover-shell";
import { loadCommitHistoryPage } from "./code-mode/data";
import type { CommitHistoryEntry } from "../../types/ipc.generated";
import "./commits-popover.css";

/** Distance from the list's bottom edge that triggers the next page. */
const LOAD_MARGIN_PX = 48;

export class CommitsPopover {
  private shell = new PopoverShell();
  private anchor: HTMLElement | null = null;
  private cwd: string | null = null;
  private popEl: HTMLElement | null = null;

  private history: CommitHistoryEntry[] = [];
  private historyLoaded = false;
  private historyMore = false;
  private historyLoading = false;
  /** Increments each resetHistory() call; a page from a superseded open() can't append. */
  private historyGen = 0;

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, cwd: string): void {
    this.anchor = anchor;
    this.cwd = cwd;
    this.resetHistory();
    this.rebuild();
    void this.loadPage();
  }

  close(): void {
    this.shell.close();
    this.anchor = null;
    this.cwd = null;
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

  private rebuild(): void {
    if (!this.anchor) return;
    // A session switch can detach the chip mid-fetch; placing against a
    // detached node parks the popover in the window's top-left corner.
    if (!this.anchor.isConnected) { this.close(); return; }
    this.shell.open(this.anchor, this.buildHtml(), {
      className: "cp-popover",
      wire: (el) => this.wire(el),
    });
  }

  private wire(el: HTMLElement): void {
    this.popEl = el;
    const list = el.querySelector<HTMLElement>(".cp-list");
    if (!list) return;
    // A copy button sits inside the row, so it must not also open the commit.
    const activate = (e: Event) => {
      const target = e.target as Element;
      if (target.closest(".cp-copy")) return;
      const row = target.closest<HTMLElement>(".cp-row[data-sha]");
      if (!row?.dataset.sha) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
      openInCodeMode({ kind: "commit", sha: row.dataset.sha, title: row.dataset.title ?? row.dataset.sha });
    };
    list.addEventListener("click", (e) => {
      const copy = (e.target as Element).closest<HTMLElement>(".cp-copy");
      if (!copy) return;
      e.stopPropagation();
      void navigator.clipboard?.writeText(copy.dataset.copy ?? "").catch(() => {});
    });
    list.addEventListener("click", activate);
    list.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") activate(e);
    });
    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - LOAD_MARGIN_PX) void this.loadPage();
    });
    this.fillViewport(list);
  }

  /** A page that doesn't overflow the list never emits a scroll event, so the
   *  next page would be unreachable. clientHeight is 0 pre-layout (and in
   *  jsdom), where "not scrollable" is meaningless - skip rather than spin. */
  private fillViewport(list: HTMLElement): void {
    if (!this.historyMore || this.historyLoading) return;
    if (list.clientHeight <= 0) return;
    if (list.scrollHeight <= list.clientHeight + LOAD_MARGIN_PX) void this.loadPage();
  }

  /** Appends the next page in place, so the scroll position that asked for it holds.
   *  Shares Code mode's page loader but not its loadOlderCommits state: that one
   *  keeps only pushed commits below the unpushed rows, this list shows every commit. */
  private async loadPage(): Promise<void> {
    if (this.historyLoading || !this.cwd) return;
    if (this.historyLoaded && !this.historyMore) return;
    const cwd = this.cwd;
    const gen = this.historyGen;
    const offset = this.history.length;
    this.historyLoading = true;
    this.paintSentinel();
    try {
      const page = await loadCommitHistoryPage(cwd, offset);
      if (this.cwd !== cwd || this.historyGen !== gen) return;
      this.historyLoading = false;
      this.historyMore = page.has_more;
      this.history = this.history.concat(page.entries);
      if (!this.historyLoaded) {
        this.historyLoaded = true;
        this.rebuild();
      } else {
        this.appendRows(page.entries);
      }
    } catch (err) {
      if (this.cwd !== cwd || this.historyGen !== gen) return;
      this.historyLoading = false;
      this.historyLoaded = true;
      this.historyMore = false;
      console.error("[commits-popover] get_commit_history failed", err);
      this.rebuild();
    }
  }

  private appendRows(entries: CommitHistoryEntry[]): void {
    const list = this.popEl?.querySelector<HTMLElement>(".cp-list");
    if (!list) { this.rebuild(); return; }
    list.querySelector(".cp-sentinel")?.remove();
    list.insertAdjacentHTML("beforeend", entries.map((c) => this.rowHtml(c)).join("") + this.sentinelHtml());
    this.fillViewport(list);
  }

  private paintSentinel(): void {
    this.popEl?.querySelector<HTMLElement>(".cp-list .cp-sentinel")?.replaceWith(this.sentinelEl());
  }

  private sentinelEl(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = this.sentinelHtml();
    return wrap.firstElementChild as HTMLElement;
  }

  private rowHtml(c: CommitHistoryEntry): string {
    const state = c.pushed ? "pushed" : "unpushed";
    const icon = c.pushed ? "ph-check" : "ph-arrow-up";
    const ms = Number(c.timestamp) * 1000;
    const hasTime = Number(c.timestamp) > 0;
    const age = hasTime ? timeAgo(new Date(ms).toISOString()) : "";
    const abs = hasTime ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    const mark = c.pushed ? "Pushed to upstream" : "Not pushed yet";
    return `<div class="cp-row ${state}" role="button" tabindex="0" data-sha="${escapeHtml(c.short_sha)}" data-title="${escapeHtml(c.message)}">`
      + `<i class="ph ${icon} cp-mark" title="${mark}"></i>`
      + `<span class="cp-sha">${escapeHtml(c.short_sha)}</span>`
      + `<span class="cp-msg">${escapeHtml(c.message)}</span>`
      + `<span class="cp-age">${escapeHtml(age)}</span>`
      + `<span class="cp-abs">${escapeHtml(abs)}</span>`
      + `<span class="cp-tools">`
      + `<button class="cp-copy" data-copy="${escapeHtml(c.short_sha)}" title="Copy hash" aria-label="Copy hash"><i class="ph ph-hash"></i></button>`
      + `<button class="cp-copy" data-copy="${escapeHtml(c.message)}" title="Copy name" aria-label="Copy name"><i class="ph ph-copy"></i></button>`
      + `</span></div>`;
  }

  private sentinelHtml(): string {
    if (this.historyLoading) {
      return `<div class="cp-sentinel loading"><i class="ph ph-spinner-gap cp-spin"></i></div>`;
    }
    if (this.historyMore) return `<div class="cp-sentinel"></div>`;
    return `<div class="cp-sentinel end">End of history</div>`;
  }

  private buildHtml(): string {
    const repo = this.cwd ? this.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? "" : "";
    const header = `<div class="cp-header"><i class="ph ph-git-commit"></i>Commits${repo ? ` &mdash; ${escapeHtml(repo)}` : ""}</div>`;
    if (!this.historyLoaded) {
      return header + `<div class="cp-empty"><i class="ph ph-spinner-gap cp-spin"></i> Loading commits&hellip;</div>`;
    }
    if (this.history.length === 0) {
      return header + `<div class="cp-empty">No commits on this branch yet</div>`;
    }
    return header + `<div class="cp-list">${this.history.map((c) => this.rowHtml(c)).join("")}${this.sentinelHtml()}</div>`;
  }
}
