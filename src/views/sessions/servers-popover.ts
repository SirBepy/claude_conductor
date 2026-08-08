/**
 * Running dev-servers statusline chip + popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import type { ServerInfo } from "../../types/ipc.generated";
import { PopoverShell } from "./statusbar-popover-shell";

export class ServersPopover {
  servers: ServerInfo[] = [];
  loaded = false;
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  /** Signature of the current list, so a background poll only re-renders on
   *  change (avoids churning the statusbar every tick). */
  private sig(list: ServerInfo[]): string {
    return list.map((s) => `${s.id}@${s.port}`).join("|");
  }

  async refresh(cwd: string, rerender: () => void): Promise<void> {
    try {
      const next = await invoke<ServerInfo[]>("list_project_servers", { cwd });
      const changed = !this.loaded || this.sig(next) !== this.sig(this.servers);
      this.servers = next;
      this.loaded = true;
      if (changed) rerender();
    } catch { /* supervisor down / transient - keep last known */ }
  }

  renderChip(cwd: string | null, animClass: (key: string) => string): string {
    if (!cwd) return "";
    if (!this.loaded) {
      return `<span class="sb-chip sb-skeleton sb-servers" data-skeleton="servers" style="min-width:52px"><i class="ph ph-broadcast"></i><span class="sb-skel-bar"></span></span>`;
    }
    const n = this.servers.length;
    if (n === 0) return "";
    const ports = this.servers.map((s) => `:${s.port}`).join(", ");
    const label = `${n} dev server${n === 1 ? "" : "s"} running for this project (${ports}). Click to open in the browser.`;
    return `<span class="sb-chip sb-servers sb-servers-btn${animClass("servers")}" role="button" tabindex="0" title="${escapeHtml(label)}"><i class="ph ph-broadcast"></i>${n} live</span>`;
  }

  /** Rebuilds in-place when called while open (re-anchor / background refresh).
   *  No-op when nothing is running. */
  open(anchor: HTMLElement): void {
    if (this.servers.length === 0) { this.shell.close(); return; }
    this.shell.open(anchor, this.buildHtml(), {
      className: "sb-servers-popover",
      wire: (el) => {
        el.querySelectorAll<HTMLElement>(".sb-servers-row").forEach((r) => {
          r.addEventListener("click", () => {
            const url = r.dataset.url;
            if (url) void invoke<void>("open_external", { url });
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
    const rows = this.servers.map((s) => {
      const url = `http://127.0.0.1:${s.port}`;
      return `<div class="sb-servers-row" role="button" tabindex="0" data-url="${escapeHtml(url)}" title="Open ${escapeHtml(url)}"><i class="ph ph-arrow-square-out"></i><span class="sb-servers-name">${escapeHtml(s.name)}</span><span class="sb-servers-port">:${s.port}</span></div>`;
    }).join("");
    return `
      <div class="sb-servers-popover-header">Running servers (${this.servers.length})</div>
      <div class="sb-servers-popover-list">${rows}</div>
    `;
  }
}
