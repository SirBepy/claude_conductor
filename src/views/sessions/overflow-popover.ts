/**
 * The panel behind the `overflow` statusline chip: counts as tiles, the two
 * drain ratios as meters, the tool tally as a stacked strip plus a key. The key
 * carries every PANEL_TOOLS entry including zeroes - a zero has no segment, so
 * without it a never-called tool would vanish rather than read as zero.
 */

import { escapeHtml } from "../../shared/escape-html";
import type { ToolTally } from "../../shared/chat/tool-meta";
import type { ChatDrain } from "../../types/ipc.generated";
import { PANEL_TOOLS } from "./statusline-catalog";
import { formatDuration, type SessionCounts } from "./session-statusbar-helpers";
import { PopoverShell } from "./statusbar-popover-shell";

export interface OverflowPanelData {
  counts: SessionCounts | null;
  startedAt: string | null;
  drain: ChatDrain | null;
  toolTally: ToolTally;
}

/** Emphasis ramp for the stacked strip and its key swatches, biggest first. */
const RAMP = [1, 0.84, 0.68, 0.54, 0.42, 0.32, 0.24];

export class OverflowPopover {
  private shell = new PopoverShell();
  private data: OverflowPanelData | null = null;

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, data: OverflowPanelData): void {
    this.data = data;
    this.shell.open(anchor, this.buildHtml(), { className: "sb-overflow-popover" });
  }

  close(): void { this.shell.close(); }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildHtml(): string {
    const d = this.data;
    if (!d) return `<div class="sb-git-pop-empty">Nothing to show yet</div>`;
    return this.statsHtml(d) + this.metersHtml(d) + this.toolsHtml(d);
  }

  private statsHtml(d: OverflowPanelData): string {
    const tile = (v: string, k: string): string =>
      `<div class="ov-tile"><div class="ov-tile-v">${escapeHtml(v)}</div><div class="ov-tile-k">${k}</div></div>`;
    // A dash, not a 0: null counts mean "not loaded", and a confident zero
    // there reads as a real measurement.
    const n = (v: number | undefined): string => (v === undefined ? "-" : String(v));
    const dur = d.startedAt ? formatDuration(d.startedAt) : "-";
    return `<div class="ov-head">This Session</div>`
      + `<div class="ov-kpi">`
      + tile(n(d.counts?.prompts), "MESSAGES")
      + tile(n(d.counts?.turns), "TURNS")
      + tile(dur, "DURATION")
      + `</div>`;
  }

  private metersHtml(d: OverflowPanelData): string {
    const meter = (label: string, pct: number | null | undefined): string => {
      const v = pct ?? null;
      const shown = v === null ? "-" : `${Math.round(v)}%`;
      const width = v === null ? 0 : Math.max(0, Math.min(100, v));
      return `<div class="ov-meter-label"><span>${label}</span><b>${shown}</b></div>`
        + `<div class="ov-meter-track"><div class="ov-meter-fill" style="width:${width}%"></div></div>`;
    };
    return `<div class="ov-meters">`
      + meter("5h Session Drained", d.drain?.fiveHourPct)
      + meter("Weekly Drained", d.drain?.weeklyPct)
      + `</div>`;
  }

  private toolsHtml(d: OverflowPanelData): string {
    const byName = new Map(d.toolTally.byType.map((b) => [b.tool, b.count]));
    const rows = PANEL_TOOLS
      .map((tool) => ({ tool, count: byName.get(tool) ?? 0 }))
      .sort((a, b) => b.count - a.count || PANEL_TOOLS.indexOf(a.tool) - PANEL_TOOLS.indexOf(b.tool));
    const total = rows.reduce((n, r) => n + r.count, 0);

    const head = `<div class="ov-head">Tools · ${total} ${total === 1 ? "Call" : "Calls"}</div>`;
    if (total === 0) return head + `<div class="ov-mix-lede">No tool calls yet</div>`;

    const top = rows[0]!;
    const lede = `<div class="ov-mix-lede">Mostly <b>${escapeHtml(top.tool)}</b>, ${Math.round((top.count / total) * 100)}% of ${total} calls</div>`;
    const strip = rows.filter((r) => r.count > 0).map((r, i) =>
      `<span style="width:${(r.count / total) * 100}%;opacity:${RAMP[i] ?? 0.2}" title="${escapeHtml(r.tool)}: ${r.count}"></span>`
    ).join("");
    const key = rows.map((r, i) =>
      `<div class="${r.count === 0 ? "zero" : ""}"><i class="ov-sw"${r.count === 0 ? "" : ` style="opacity:${RAMP[i] ?? 0.2}"`}></i>`
      + `<span class="ov-nm">${escapeHtml(r.tool)}</span><b>${r.count}</b></div>`
    ).join("");

    return head + lede + `<div class="ov-mix">${strip}</div><div class="ov-mixrow">${key}</div>`;
  }
}
