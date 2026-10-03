import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { openLightbox } from "../../shared/chat/lightbox";
import { openInCodeMode } from "../../shared/chat/code-mode-bridge";
import { toolSummary, toolLabel, type ToolTally } from "../../shared/chat/tool-meta";
import { CUSTOM_VIEW_TOOLS } from "../../shared/chat/tool-views";
import { PopoverShell } from "./statusbar-popover-shell";
import "./session-tally.css";

// Cumulative tool tally row: one chip per tool type, each its OWN drill-down
// popover listing that tool's distinct targets (files open in the editor,
// images open a lightbox, Grep/Bash targets are plain text). The row is
// always-on when tools have run, not a configurable statusline field.
//
// Owns the chip-row HTML build, the body-appended drill-down popover, its
// open/close/toggle, per-item rendering, outside-click cleanup and the
// downward/upward positioning. SessionStatusbar holds the toolTally +
// tallyHiddenTools STATE and delegates the row build + chip click wiring here.
export class ToolTallyRow {
  private container: HTMLElement;
  private toolTally: ToolTally = { byType: [] };
  private shell = new PopoverShell();
  // Which tool's popover is open (null = none); kept so updateToolTally can
  // rebuild it in place as more calls of that type stream in.
  private tallyOpenTool: string | null = null;
  // Fired just before a tool popover opens, so the owner can dismiss its own
  // (statusbar) popovers and keep one-at-a-time behaviour.
  private beforeOpen: (() => void) | null = null;
  // Provider for the shared custom views (Read/File Changes/Skills/Questions),
  // backed by the chat renderer's messages. When set, custom-tool popovers reuse
  // the exact same markup as the in-chat chip panels instead of the generic
  // target list. Null until the renderer is wired (e.g. pending-pane previews).
  private getCustomView: ((tool: string) => string | null) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Register a callback fired right before a tool popover opens (used to close
   *  the sibling statusbar popovers so only one popover is open at a time). */
  setBeforeOpen(fn: () => void): void {
    this.beforeOpen = fn;
  }

  /** Close the tool popover if open (public so the owner can dismiss it). */
  closePopover(): void {
    this.closeTallyPopover();
  }

  /** Wire the shared custom-view provider (the chat renderer's message-derived
   *  HTML). Safe to call after construction; refreshes an open popover. */
  setCustomViewProvider(fn: (tool: string) => string | null): void {
    this.getCustomView = fn;
    if (this.tallyOpenTool) this.openToolPopover(this.tallyOpenTool);
  }

  /** Build ONE tool chip's HTML (count + drill-down affordance) for a given
   *  tool, or "" when hideZero is on and the count is 0 / the tool never ran.
   *  `count` is passed by the caller (SessionStatusbar owns the tally state);
   *  this controller only owns the popover. Used by the rows renderer, which
   *  places each tool as an individual chip. */
  renderChipFor(tool: string, count: number, hideZero: boolean): string {
    if (count === 0 && hideZero) return "";
    const { icon } = toolSummary(tool, {});
    const label = toolLabel(tool);
    return `<span class="sb-tally-chip sb-chip" role="button" tabindex="0" data-tool="${escapeHtml(tool)}" title="${escapeHtml(label)} targets"><i class="ph ${icon}"></i>${escapeHtml(label)} x${count}</span>`;
  }

  // Wire the freshly-rendered chips' click handlers. Call after the container's
  // innerHTML is set on every render.
  wireChips(): void {
    this.container.querySelectorAll<HTMLElement>(".sb-tally-chip").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const tool = chip.dataset.tool;
        if (tool) this.toggleToolPopover(tool);
      });
    });
  }

  // Sync the tally state + keep an open popover in sync after a re-render: the
  // chips were rebuilt, so reattach the open popover to the new anchor (or close
  // it if its tool vanished).
  update(tally: ToolTally): void {
    this.toolTally = tally;
    const openTool = this.shell.isOpen ? this.tallyOpenTool : null;
    if (openTool && tally.byType.some((b) => b.tool === openTool)) {
      this.openToolPopover(openTool);
    } else {
      this.closeTallyPopover();
    }
  }

  destroy(): void {
    this.closeTallyPopover();
  }

  private toggleToolPopover(tool: string): void {
    if (this.shell.isOpen && this.tallyOpenTool === tool) this.closeTallyPopover();
    else this.openToolPopover(tool);
  }

  private closeTallyPopover(): void {
    this.shell.close();
    this.tallyOpenTool = null;
  }

  // Per-tool drill-down popover, anchored to that tool's chip. Uses the shared
  // PopoverShell (below the chip, centered, window-clamped, scrollable) and is
  // rebuilt in place (same tool) as more calls of that type stream in.
  private openToolPopover(tool: string): void {
    const anchor = [...this.container.querySelectorAll<HTMLElement>(".sb-tally-chip")]
      .find((c) => c.dataset.tool === tool);
    if (!anchor) return;
    this.beforeOpen?.();
    this.tallyOpenTool = tool;

    this.shell.open(anchor, `<div class="sb-tally-list">${this.renderToolItems(tool)}</div>`, {
      className: "sb-tally-popover",
      wire: (pop) => this.wireItems(pop),
    });
  }

  private wireItems(pop: HTMLElement): void {
    // File rows, and the shared custom-view file rows (Read / File Changes),
    // open that file in Code mode.
    pop.querySelectorAll<HTMLElement>(".sb-tally-file, .tool-file-row[data-path]").forEach((row) => {
      row.addEventListener("click", () => {
        const path = row.dataset.path;
        if (!path) return;
        this.shell.close();
        openInCodeMode({ kind: "file", path });
      });
    });

    pop.querySelectorAll<HTMLElement>(".sb-tally-media").forEach((row) => {
      const path = row.dataset.path;
      const filename = row.dataset.filename ?? "";
      const imgEl = row.querySelector<HTMLImageElement>("img");
      if (path && imgEl) {
        void invoke<{ mime: string; base64: string }>("read_image_file", { path })
          .then((res) => { imgEl.src = `data:${res.mime};base64,${res.base64}`; })
          .catch(() => { row.classList.add("sb-tally-media-error"); });
      }
      row.addEventListener("click", () => {
        if (!path) return;
        void invoke<{ mime: string; base64: string }>("read_image_file", { path })
          .then((res) => openLightbox({ type: "image", mime: res.mime, base64: res.base64, filename }))
          .catch((err) => console.error("[statusbar] read_image_file failed", err));
      });
    });
  }

  private renderToolItems(tool: string): string {
    // Custom-view tools (Read / File Changes / Skills / Questions) reuse the
    // shared in-chat markup, built from the renderer's messages.
    if (CUSTOM_VIEW_TOOLS.has(tool) && this.getCustomView) {
      const html = this.getCustomView(tool);
      if (html) return html;
      return `<div class="sb-tally-empty">No targets</div>`;
    }
    const entry = this.toolTally.byType.find((b) => b.tool === tool);
    const items = entry?.items ?? [];
    if (items.length === 0) return `<div class="sb-tally-empty">No targets</div>`;
    return items.map((it) => {
      const count = it.count > 1 ? ` <span class="sb-tally-count">x${it.count}</span>` : "";
      if (it.kind === "image" && it.path) {
        const pathEsc = escapeHtml(it.path);
        const nameEsc = escapeHtml(it.filename ?? it.label);
        return `<div class="sb-tally-media" role="button" title="${pathEsc}" data-path="${pathEsc}" data-filename="${nameEsc}"><span class="sb-tally-thumb"><img alt="${nameEsc}"><i class="ph ph-image sb-tally-thumb-ph"></i></span><span class="sb-tally-name">${nameEsc}</span>${count}</div>`;
      }
      if (it.kind === "file" && it.path) {
        const pathEsc = escapeHtml(it.path);
        return `<div class="sb-tally-file" role="button" title="${pathEsc}" data-path="${pathEsc}"><i class="ph ph-file"></i><span class="sb-tally-name">${escapeHtml(it.label)}</span><span class="sb-tally-path">${pathEsc}</span>${count}</div>`;
      }
      const labelEsc = escapeHtml(it.label);
      return `<div class="sb-tally-text" title="${labelEsc}"><i class="ph ${toolSummary(tool, {}).icon}"></i><span class="sb-tally-name">${labelEsc}</span>${count}</div>`;
    }).join("");
  }
}
