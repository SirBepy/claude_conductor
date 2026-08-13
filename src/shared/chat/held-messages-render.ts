// Chip + floating dropdown rendering for HeldMessages (split out per todo #543).
// The controller (held-messages.ts) owns state/flush logic and composes this
// via the HeldRenderHost interface; this module only touches DOM + expanded/
// outside-click UI state.

import { blocksToText } from "./content-blocks";
import type { HeldAttach, HeldItem } from "./held-messages";

export interface HeldRenderHost {
  getAttached(): HeldAttach | null;
  itemsForActive(): HeldItem[];
  /** Mutate the backing map + persist for one item (id removal or edit). */
  removeItem(id: number): void;
  editItem(id: number, text: string): void;
  /** Bypass the edit's debounced daemon push (row blur). */
  flushEditPush(id: number): void;
  sendNow(): Promise<void>;
}

export class HeldMessagesRender {
  private expanded = false;
  private closeDropdownOutside: ((e: MouseEvent) => void) | null = null;

  constructor(private host: HeldRenderHost) {}

  /** Called on attach()/flush(): collapse and drop any open dropdown/listener. */
  reset(): void {
    this.closeDropdown();
    this.expanded = false;
  }

  renderChip(): void {
    const a = this.host.getAttached();
    if (!a || !a.chipSlot) return;
    const items = this.host.itemsForActive();
    if (items.length === 0) {
      a.chipSlot.innerHTML = "";
      this.closeDropdown();
      return;
    }
    const n = items.length;
    a.chipSlot.innerHTML = `
      <button class="held-chip" type="button" title="Show unsent messages">
        <span class="held-count">${n}</span> ${n === 1 ? "message" : "messages"} waiting
        <i class="ph ph-caret-${this.expanded ? "up" : "down"}"></i>
      </button>
      <button class="held-send-now" type="button">Send now</button>
    `;
    a.chipSlot.querySelector<HTMLButtonElement>(".held-chip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.expanded = !this.expanded;
      this.renderChip();
    });
    a.chipSlot.querySelector<HTMLButtonElement>(".held-send-now")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.host.sendNow();
    });
    if (this.expanded) this.renderDropdown();
    else this.closeDropdown();
  }

  private renderDropdown(): void {
    const a = this.host.getAttached();
    if (!a || !a.anchor) return;
    this.closeDropdown();
    const items = this.host.itemsForActive();
    const dd = document.createElement("div");
    dd.className = "held-dropdown";
    const title = document.createElement("div");
    title.className = "held-dropdown-title";
    title.textContent = "Unsent — these send as one message";
    dd.appendChild(title);
    const rows = document.createElement("div");
    rows.className = "held-rows";
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "held-row";
      row.contentEditable = "true";
      row.spellcheck = false;
      row.textContent = blocksToText(item.blocks);
      row.addEventListener("input", () => {
        // Update the model live (no re-render -> caret stays put).
        this.host.editItem(item.id, row.textContent ?? "");
      });
      row.addEventListener("blur", () => {
        if (!(row.textContent ?? "").trim()) this.removeItem(item.id);
        else this.host.flushEditPush(item.id);
      });
      rows.appendChild(row);
    }
    dd.appendChild(rows);
    a.anchor.appendChild(dd);
    // Outside-click closes (mirrors the statusbar popover pattern). Deferred
    // bind so the opening click isn't immediately caught.
    this.closeDropdownOutside = (e: MouseEvent) => {
      if (!a.anchor.contains(e.target as Node)) {
        this.expanded = false;
        this.renderChip();
      }
    };
    setTimeout(() => {
      if (this.closeDropdownOutside) document.addEventListener("click", this.closeDropdownOutside);
    }, 0);
  }

  private removeItem(id: number): void {
    this.host.removeItem(id);
    if (this.host.itemsForActive().length === 0) this.expanded = false;
    this.renderChip();
    this.host.getAttached()?.onChange();
  }

  private closeDropdown(): void {
    this.host.getAttached()?.anchor?.querySelector(".held-dropdown")?.remove();
    this.detachOutsideClick();
  }

  private detachOutsideClick(): void {
    if (this.closeDropdownOutside) {
      document.removeEventListener("click", this.closeDropdownOutside);
      this.closeDropdownOutside = null;
    }
  }
}
