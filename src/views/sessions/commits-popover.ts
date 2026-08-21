/**
 * Ahead/behind commits statusline chip + popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { PopoverShell } from "./statusbar-popover-shell";

export interface CommitEntry { short_sha: string; message: string; }
export interface CommitSync { ahead: CommitEntry[]; behind: CommitEntry[]; has_upstream: boolean; }

export class CommitsPopover {
  private shell = new PopoverShell();
  private anchor: HTMLElement | null = null;
  private cwd: string | null = null;
  private sync: CommitSync | null = null;
  private branch: string | null = null;
  private onPushed: (() => void) | null = null;
  private pushing = false;
  private pushError: string | null = null;

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
    this.rebuild();
  }

  close(): void {
    this.shell.close();
    this.anchor = null;
    this.cwd = null;
    this.sync = null;
    this.onPushed = null;
  }

  reanchor(anchor: HTMLElement): void {
    this.anchor = anchor;
    this.shell.reanchor(anchor);
  }

  private rebuild(): void {
    if (!this.anchor) return;
    this.shell.open(this.anchor, this.buildHtml(), {
      className: "sb-git-popover sb-commits-popover",
      wire: (el) => this.wire(el),
    });
  }

  private wire(el: HTMLElement): void {
    el.querySelector<HTMLElement>(".sb-git-pop-push-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.doPush(false);
    });
    el.querySelector<HTMLElement>(".sb-git-pop-publish-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.doPush(true);
    });
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
      this.rebuild();
    } catch (e) {
      if (this.cwd !== cwd) return;
      this.pushing = false;
      this.pushError = e instanceof Error ? e.message : String(e);
      this.rebuild();
    }
  }

  private buildHtml(): string {
    const sync = this.sync;
    if (!sync) return `<div class="sb-git-pop-empty">Loading&hellip;</div>`;
    const errorHtml = this.pushError
      ? `<div class="sb-git-pop-error"><i class="ph ph-warning"></i>${escapeHtml(this.pushError)}</div>`
      : "";
    if (!sync.has_upstream) {
      const spin = this.pushing
        ? `<i class="ph ph-spinner-gap sb-git-pop-spin"></i> Publishing&hellip;`
        : `<i class="ph ph-cloud-arrow-up"></i> Publish${this.branch ? ` "${escapeHtml(this.branch)}"` : " branch"}`;
      return `<div class="sb-git-pop-empty">No upstream configured for this branch</div>
        <div class="sb-git-pop-publish"><button class="sb-git-pop-publish-btn"${this.pushing ? " disabled" : ""}>${spin}</button></div>
        ${errorHtml}`;
    }
    const { ahead, behind } = sync;
    if (ahead.length === 0 && behind.length === 0) {
      return `<div class="sb-git-pop-empty"><i class="ph ph-check-circle"></i> Up to date with upstream</div>`;
    }
    const parts: string[] = [];
    if (ahead.length > 0) {
      const rows = ahead.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      const pushBtn = this.pushing
        ? `<button class="sb-git-pop-push-btn" disabled><i class="ph ph-spinner-gap sb-git-pop-spin"></i></button>`
        : `<button class="sb-git-pop-push-btn"><i class="ph ph-cloud-arrow-up"></i> Push</button>`;
      parts.push(`<div class="sb-git-pop-section ahead"><i class="ph ph-arrow-up"></i>Outgoing <span class="sb-git-pop-count">${ahead.length}</span>${pushBtn}</div><div class="sb-git-pop-list">${rows}</div>`);
    }
    if (behind.length > 0) {
      const rows = behind.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      parts.push(`<div class="sb-git-pop-section behind"><i class="ph ph-arrow-down"></i>Incoming <span class="sb-git-pop-count">${behind.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    return parts.join("") + errorHtml;
  }
}
