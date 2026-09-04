/**
 * AI-todos statusline chip + file-list popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import type { AiTodoEntry } from "../../types/ipc.generated";
import { PopoverShell } from "./statusbar-popover-shell";

export class AiTodosPopover {
  files: AiTodoEntry[] = [];
  loaded = false;
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  async refresh(cwd: string, rerender: () => void): Promise<void> {
    try {
      const files = await invoke<AiTodoEntry[]>("list_ai_todos", { cwd });
      // A null/absent list means "none", not "crash the whole bar" - the chip
      // ships in the default rows now, so every render path reaches this.
      this.files = files ?? [];
      this.loaded = true;
      rerender();
    } catch { /* transient */ }
  }

  renderChip(cwd: string | null, animClass: (key: string) => string): string {
    if (!cwd) return "";
    if (!this.loaded) {
      return `<span class="sb-chip sb-skeleton sb-ai-todos" data-skeleton="ai_todos" style="min-width:55px"><i class="ph ph-check-square"></i><span class="sb-skel-bar"></span></span>`;
    }
    const n = this.files.length;
    if (n === 0) return "";
    return `<span class="sb-chip sb-ai-todos sb-ai-todos-btn${animClass("ai_todos")}" role="button" tabindex="0" title="${n} AI todo${n === 1 ? "" : "s"} in .claude/todos"><i class="ph ph-check-square"></i>${n} todo${n === 1 ? "" : "s"}</span>`;
  }

  /** Rebuilds in-place when called while open (re-anchor after a chip re-render
   *  or a background list refresh). No-op when there are no todos. */
  open(anchor: HTMLElement): void {
    if (this.files.length === 0) { this.shell.close(); return; }
    this.shell.open(anchor, this.buildHtml(), {
      className: "sb-ai-todos-popover",
      wire: (el) => {
        el.querySelectorAll<HTMLElement>(".sb-ai-todos-popover-file").forEach((f) => {
          f.addEventListener("click", () => {
            const p = f.dataset.path;
            if (p) void invoke<void>("open_in_editor", { path: p });
          });
        });
      },
    });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor);
  }

  private buildHtml(): string {
    return `
      <div class="sb-ai-todos-popover-header">AI Todos (${this.files.length})</div>
      <div class="sb-ai-todos-popover-list">
        ${this.files.map((f) => `<div class="sb-ai-todos-popover-file" role="button" tabindex="0" data-path="${escapeHtml(f.path)}">${escapeHtml(f.name)}</div>`).join("")}
      </div>
    `;
  }
}
