/**
 * Token-drain statusline chip + per-message rundown popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { formatTokenCount } from "../../shared/chat/turn-chips";
import type { ChatDrain } from "../../types/ipc.generated";
import { drainCache } from "./session-statusbar-helpers";
import { PopoverShell } from "./statusbar-popover-shell";

export class DrainPopover {
  drain: ChatDrain | null = null;
  private inflight = false;
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  async refresh(sid: string, rerender: () => void, reanchor: () => void): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const d = await invoke<ChatDrain | null>("chat_drain", { sessionId: sid });
      if (d) {
        this.drain = d;
        drainCache.set(sid, d);
        rerender();
        if (this.shell.isOpen) reanchor();
      }
    } catch { /* transient */ }
    finally { this.inflight = false; }
  }

  renderChip(animClass: (key: string) => string): string {
    const d = this.drain;
    if (!d) {
      return `<span class="sb-chip sb-drain sb-drain-btn muted${animClass("drain")}" role="button" tabindex="0" aria-label="Token drain (loading)" title="Share of a 5h session this chat has used (loading)"><i class="ph ph-drop"></i>··%</span>`;
    }
    if (d.fiveHourPct === null) {
      const label = "No usage data yet to compute this chat's share. Click for the token rundown.";
      return `<span class="sb-chip sb-drain sb-drain-btn muted${animClass("drain")}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="ph ph-drop"></i>—%</span>`;
    }
    const five = Math.round(d.fiveHourPct);
    const week = Math.round(d.weeklyPct ?? 0);
    const cls = d.fiveHourPct >= 80 ? " danger" : d.fiveHourPct >= 50 ? " warn" : "";
    const label = `This chat is ${five}% of your current 5h session and ${week}% of the week. Click for a per-message rundown.`;
    return `<span class="sb-chip sb-drain sb-drain-btn${cls}${animClass("drain")}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="ph ph-drop"></i>${five}% · ${week}%w</span>`;
  }

  /** Rebuilds in-place when called while open (background refresh / re-anchor). */
  open(anchor: HTMLElement): void {
    this.shell.open(anchor, this.buildHtml(), { className: "sb-drain-popover" });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor);
  }

  private buildHtml(): string {
    const d = this.drain;
    if (!d) return `<div class="sb-drain-empty">No drain data yet</div>`;
    const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v)}%`);
    const tokens = formatTokenCount(Number(d.tokens), { decimals: 1 });
    const header = `
      <div class="sb-drain-header">
        <span class="sb-drain-stat"><span class="sb-drain-stat-val">${pct(d.fiveHourPct)}</span><span class="sb-drain-stat-lbl">of your 5h session</span></span>
        <span class="sb-drain-stat"><span class="sb-drain-stat-val">${pct(d.weeklyPct)}</span><span class="sb-drain-stat-lbl">of the week</span></span>
      </div>
      <div class="sb-drain-secondary"><i class="ph ph-coins"></i>${escapeHtml(tokens)} tokens used</div>`;
    const rows = d.messages.length === 0
      ? `<div class="sb-drain-empty">No message breakdown yet</div>`
      : d.messages.map((m) => {
          const flag = m.expensive ? ' <i class="ph ph-warning sb-drain-flag"></i>' : "";
          const expCls = m.expensive ? " expensive" : "";
          const tok = formatTokenCount(Number(m.tokens), { decimals: 1 });
          return `<div class="sb-drain-row${expCls}" title="${escapeHtml(m.preview)}"><span class="sb-drain-idx">#${m.index}</span><span class="sb-drain-preview">${escapeHtml(m.preview)}</span>${flag}<span class="sb-drain-tokens">${escapeHtml(tok)} tok</span></div>`;
        }).join("");
    return `${header}<div class="sb-drain-list">${rows}</div>`;
  }
}
