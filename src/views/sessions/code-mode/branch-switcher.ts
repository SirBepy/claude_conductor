// The branch list behind Code mode's `origin/<branch>` control: filterable
// rows, a real `checkout_branch` on pick, and the two warnings that matter
// before one (uncommitted files ride along; another Conductor session is live
// in the same repo). Lifted out of the git card so there is one branch list.

import { escapeHtml } from "../../../shared/escape-html";
import { invoke } from "../../../shared/ipc";
import type { BranchEntry, Instance } from "../../../types/ipc.generated";
import "./branch-switcher.css";

export interface BranchSwitcherOpts {
  cwd: string;
  /** This chat's own session id, excluded from the peer-session warning. */
  sessionId: string | null;
  onCheckedOut: () => void;
  onClose: () => void;
  /** Preview icon on a row: read-only, no checkout. Omit to hide the icon,
   *  e.g. when a caller only wants the plain picker. */
  onPreview?: (name: string) => void;
  /** Pre-fills the search box, e.g. the explorer's Check out button jumping
   *  straight to the one branch it's offering to check out. */
  initialFilter?: string;
}

interface BranchContext {
  dirty: string[];
  peerActive: boolean;
}

export class BranchSwitcher {
  private host: HTMLElement | null = null;
  private branches: BranchEntry[] | null = null;
  private context: BranchContext | null = null;
  private filter = "";
  private checkingOut: string | null = null;
  private error: string | null = null;

  constructor(private readonly opts: BranchSwitcherOpts) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (this.opts.initialFilter) this.filter = this.opts.initialFilter;
    this.render();
    host.querySelector<HTMLInputElement>(".bs-search input")?.focus();
    void this.load();
  }

  unmount(): void {
    this.host = null;
  }

  /** Branches plus the dirty/peer context, fetched together on every open:
   *  both go stale the moment the user switches away and back. */
  private async load(): Promise<void> {
    const { cwd, sessionId } = this.opts;
    const [branches, dirty, instances] = await Promise.all([
      invoke<BranchEntry[]>("get_recent_branches", { cwd }).catch(() => [] as BranchEntry[]),
      invoke<string[]>("get_git_dirty", { cwd }).then((d) => d ?? []).catch(() => [] as string[]),
      invoke<Instance[]>("list_instances").then((i) => i ?? []).catch(() => [] as Instance[]),
    ]);
    if (!this.host) return;
    this.branches = branches;
    this.context = {
      dirty,
      peerActive: instances.some((i) => i.cwd === cwd && i.session_id !== sessionId && i.ended_at === null),
    };
    this.render();
  }

  private async checkout(name: string): Promise<void> {
    if (this.checkingOut) return;
    this.checkingOut = name;
    this.error = null;
    this.paintRows();
    try {
      await invoke<void>("checkout_branch", { cwd: this.opts.cwd, name });
      this.checkingOut = null;
      this.opts.onCheckedOut();
    } catch (e) {
      this.checkingOut = null;
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  private render(): void {
    const host = this.host;
    if (!host) return;
    const peerWarn = this.context?.peerActive
      ? `<div class="gc-peer-warn"><i class="ph ph-users"></i><span>Another Conductor session is active in this repo</span></div>`
      : "";
    const dirtyCount = this.context?.dirty.length ?? 0;
    const dirtyWarn = dirtyCount > 0
      ? `<div class="gc-dirty-warn"><i class="ph ph-warning-circle"></i><span>${dirtyCount} uncommitted file${dirtyCount === 1 ? "" : "s"} will come with you</span></div>`
      : "";
    const error = this.error
      ? `<div class="sb-git-pop-error"><i class="ph ph-warning"></i>${escapeHtml(this.error)}</div>`
      : "";
    host.innerHTML = `<div class="bs-search"><i class="ph ph-magnifying-glass"></i><input value="${escapeHtml(this.filter)}" spellcheck="false" placeholder="Switch branch" aria-label="Filter branches"></div>`
      + `<div class="sb-git-pop-list bs-list">${this.rowsHtml()}</div>`
      + peerWarn + dirtyWarn + error;
    this.wire(host);
  }

  /** Filtering repaints only the rows, so the caret in the search box
   *  survives every keystroke. */
  private paintRows(): void {
    const list = this.host?.querySelector<HTMLElement>(".bs-list");
    if (list) list.innerHTML = this.rowsHtml();
  }

  private wire(host: HTMLElement): void {
    const input = host.querySelector<HTMLInputElement>(".bs-search input")!;
    input.addEventListener("input", () => {
      this.filter = input.value;
      this.paintRows();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.opts.onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        host.querySelector<HTMLElement>(".sb-git-pop-row.pick")?.focus();
      }
    });
    // On the list container, not per row: paintRows() swaps only its innerHTML.
    const list = host.querySelector<HTMLElement>(".bs-list")!;
    const pick = (e: Event) => {
      const previewBtn = (e.target as Element).closest<HTMLElement>(".bs-preview[data-preview]");
      if (previewBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.opts.onPreview?.(previewBtn.dataset.preview!);
        return;
      }
      const row = (e.target as Element).closest<HTMLElement>(".sb-git-pop-row.pick[data-branch]");
      if (!row?.dataset.branch) return;
      e.preventDefault();
      e.stopPropagation();
      void this.checkout(row.dataset.branch);
    };
    list.addEventListener("click", pick);
    list.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") pick(e);
      else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.opts.onClose();
      }
    });
  }

  private rowsHtml(): string {
    const all = this.branches;
    if (all === null) return `<div class="sb-git-pop-empty"><i class="ph ph-spinner-gap sb-git-pop-spin"></i> Loading branches&hellip;</div>`;
    const q = this.filter.trim().toLowerCase();
    const shown = q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
    if (shown.length === 0) {
      return `<div class="sb-git-pop-empty">${all.length === 0 ? "No branches found" : "No branch matches that"}</div>`;
    }
    return shown.map((b) => {
      const check = b.current ? `<i class="ph ph-check sb-git-pop-check"></i>` : `<span class="sb-git-pop-check-pad"></span>`;
      const sha = b.short_sha ? `<span class="sb-git-pop-sha">${escapeHtml(b.short_sha)}</span>` : "";
      const up = b.upstream ? `<span class="sb-git-pop-upstream">${escapeHtml(b.upstream)}</span>` : "";
      if (b.current) {
        return `<div class="sb-git-pop-row current">${check}<span class="sb-git-pop-name">${escapeHtml(b.name)}</span>${sha}${up}</div>`;
      }
      const busy = this.checkingOut === b.name;
      const spin = busy ? `<i class="ph ph-spinner-gap sb-git-pop-spin gc-row-spin"></i>` : "";
      const preview = this.opts.onPreview && !busy
        ? `<button class="bs-preview" data-preview="${escapeHtml(b.name)}" title="Preview without checking out" aria-label="Preview ${escapeHtml(b.name)}"><i class="ph ph-eye"></i></button>`
        : "";
      return `<div class="sb-git-pop-row pick${busy ? " busy" : ""}" role="button" tabindex="0" data-branch="${escapeHtml(b.name)}"${busy ? ` aria-busy="true"` : ""}>`
        + `${check}<span class="sb-git-pop-name">${escapeHtml(b.name)}</span>${sha}${up}${preview}${spin}</div>`;
    }).join("");
  }
}
