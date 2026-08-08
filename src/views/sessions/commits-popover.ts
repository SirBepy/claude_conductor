/**
 * Ahead/behind commits statusline chip + popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { PopoverShell } from "./statusbar-popover-shell";

export interface CommitEntry { short_sha: string; message: string; }
export interface CommitSync { ahead: CommitEntry[]; behind: CommitEntry[]; has_upstream: boolean; }

export class CommitsPopover {
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, sync: CommitSync): void {
    this.shell.open(anchor, this.buildHtml(sync), { className: "sb-git-popover sb-commits-popover" });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement, sync: CommitSync): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor, sync);
  }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildHtml(sync: CommitSync): string {
    if (!sync.has_upstream) {
      return `<div class="sb-git-pop-empty">No upstream configured for this branch</div>`;
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
      parts.push(`<div class="sb-git-pop-section ahead"><i class="ph ph-arrow-up"></i>Outgoing <span class="sb-git-pop-count">${ahead.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    if (behind.length > 0) {
      const rows = behind.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      parts.push(`<div class="sb-git-pop-section behind"><i class="ph ph-arrow-down"></i>Incoming <span class="sb-git-pop-count">${behind.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    return parts.join("");
  }
}
