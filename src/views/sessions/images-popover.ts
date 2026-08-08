/**
 * Chat-wide image list statusline chip + popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { collectChatImages, type ChatImageCollection } from "../../shared/chat/chat-image-gallery-data";
import { openChatImageGallery } from "../../shared/chat/chat-image-gallery";
import type { RenderedMessage } from "../../shared/chat/chat-transforms";
import { sessionEvents } from "../../shared/chat/event-store";
import { startBackgroundImageFill, shadowMessageEls } from "../../shared/chat/chat-image-history-fill";
import { PopoverShell } from "./statusbar-popover-shell";

export class ImagesPopover {
  collection: ChatImageCollection | null = null;
  private hasMoreOlder = false;
  private sessionId: string | null = null;
  private cwd: string | undefined;
  private shell = new PopoverShell();
  // Scoped to "popover is open" - started on open(), cancelled via the shell's
  // onClose hook so every close path (button toggle, outside-click) stops it.
  private fillCancel: (() => void) | null = null;
  private lastAnchor: HTMLElement | null = null;
  private extraMessages: RenderedMessage[] = [];
  private baseMessages: RenderedMessage[] = [];
  private baseMessageEls: HTMLElement[] = [];

  get isOpen(): boolean { return this.shell.isOpen; }

  // Recomputes `collection` from the live snapshot merged with whatever the
  // background fill (see open()) has accumulated, so neither source clobbers
  // the other. Called on every render and after each fill page.
  refresh(messages: RenderedMessage[], messageEls: HTMLElement[], hasMore: boolean, sessionId: string | null, cwd: string | undefined): void {
    this.hasMoreOlder = hasMore;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.baseMessages = messages;
    this.baseMessageEls = messageEls;
    this.collection = this.mergedCollection();
  }

  private mergedCollection(): ChatImageCollection {
    if (this.extraMessages.length === 0) return collectChatImages(this.baseMessages, this.baseMessageEls);
    const extraEls = this.extraMessages.map((m) => shadowMessageEls.get(m) ?? document.createElement("div"));
    return collectChatImages([...this.extraMessages, ...this.baseMessages], [...extraEls, ...this.baseMessageEls]);
  }

  renderChip(animClass: (key: string) => string): string {
    const c = this.collection;
    if (!c || c.images.length === 0) return "";
    const n = c.images.length;
    const label = `${n} image${n === 1 ? "" : "s"} in this chat (attachments + tool screenshots). Click to view.`;
    return `<span class="sb-chip sb-images sb-images-btn${animClass("images")}" role="button" tabindex="0" title="${escapeHtml(label)}"><i class="ph ph-image"></i>${n} img${n === 1 ? "" : "s"}</span>`;
  }

  /** Rebuilds in-place when called while open (re-anchor / background refresh).
   *  No-op when there are no images. */
  open(anchor: HTMLElement): void {
    if (!this.collection || this.collection.images.length === 0) { this.shell.close(); return; }
    this.lastAnchor = anchor;
    this.shell.open(anchor, this.buildHtml(), {
      className: "sb-images-popover",
      onClose: () => {
        this.fillCancel?.();
        this.fillCancel = null;
        this.extraMessages = [];
      },
      wire: (el) => {
        el.querySelector<HTMLElement>(".sb-images-popover-close")?.addEventListener("click", () => this.close());
        el.querySelectorAll<HTMLElement>(".sb-images-row").forEach((row) => {
          row.addEventListener("click", () => {
            const idx = Number(row.dataset.imageIndex);
            if (this.collection && !Number.isNaN(idx)) openChatImageGallery(this.collection, idx);
            this.close();
          });
        });
      },
    });
    this.startFillIfNeeded();
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor);
  }

  /** Starts paging older history into `collection` in the background, once,
   *  for the lifetime of this open popover. No-op if already running or there
   *  is nothing older to fetch. */
  private startFillIfNeeded(): void {
    if (this.fillCancel || !this.sessionId || !sessionEvents.hasMore(this.sessionId)) return;
    const sid = this.sessionId;
    this.fillCancel = startBackgroundImageFill(sid, this.cwd, (extraMessages, hasMore) => {
      this.extraMessages = extraMessages;
      this.hasMoreOlder = hasMore;
      this.collection = this.mergedCollection();
      if (this.isOpen && this.lastAnchor) this.open(this.lastAnchor);
    });
  }

  private buildHtml(): string {
    const c = this.collection;
    if (!c) return "";
    const rows = c.images.map((img) => {
      const turnNumber = c.entries[img.entryIndex]?.turnNumber ?? "";
      return `
        <div class="sb-images-row" role="button" tabindex="0" data-agent="${escapeHtml(img.agentKind)}" data-image-index="${img.index}">
          <div class="sb-images-row-thumb"><i class="ph ph-image"></i></div>
          <div class="sb-images-row-main">
            <div class="sb-images-row-name">${escapeHtml(img.title)}</div>
            <div class="sb-images-row-turn">Turn ${turnNumber}</div>
          </div>
          <span class="sb-images-row-tag">${escapeHtml(img.agentTag)}</span>
        </div>`;
    }).join("");
    const loading = this.hasMoreOlder
      ? `<div class="sb-images-loading"><span class="sb-images-spinner"></span>loading earlier images…</div>`
      : "";
    return `
      <div class="sb-images-popover-header">
        <span>Images (${c.images.length})</span>
        <span class="sb-images-popover-close" role="button" tabindex="0" aria-label="Close"><i class="ph ph-x"></i></span>
      </div>
      <div class="sb-images-list">${rows}${loading}</div>
    `;
  }
}
