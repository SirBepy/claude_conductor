/**
 * Recent-branches statusline chip + popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { PopoverShell } from "./statusbar-popover-shell";

export interface BranchEntry { name: string; current: boolean; short_sha: string | null; upstream: string | null; }

export class BranchPopover {
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, branches: BranchEntry[]): void {
    this.shell.open(anchor, this.buildHtml(branches), { className: "sb-git-popover sb-branch-popover" });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement, branches: BranchEntry[]): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor, branches);
  }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildHtml(branches: BranchEntry[]): string {
    const header = `<div class="sb-git-pop-header"><i class="ph ph-git-branch"></i>Recent branches</div>`;
    if (branches.length === 0) return `${header}<div class="sb-git-pop-empty">No branches found</div>`;
    const rows = branches.map((b) => {
      const check = b.current ? `<i class="ph ph-check sb-git-pop-check"></i>` : `<span class="sb-git-pop-check-pad"></span>`;
      const sha = b.short_sha ? `<span class="sb-git-pop-sha">${escapeHtml(b.short_sha)}</span>` : "";
      const up = b.upstream ? `<span class="sb-git-pop-upstream">${escapeHtml(b.upstream)}</span>` : "";
      return `<div class="sb-git-pop-row${b.current ? " current" : ""}">${check}<span class="sb-git-pop-name">${escapeHtml(b.name)}</span>${sha}${up}</div>`;
    }).join("");
    return `${header}<div class="sb-git-pop-list">${rows}</div>`;
  }
}
