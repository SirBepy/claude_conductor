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
  /** False when the turn ignored the interrupt and the set stayed held. */
  sendNow(): Promise<boolean>;
  /** A held row just lost focus - retry a deferred completion auto-flush. */
  onRowBlur(): void;
}

export class HeldMessagesRender {
  private expanded = false;
  private closeDropdownOutside: ((e: MouseEvent) => void) | null = null;
  // Ids the dropdown currently reflects. Lets renderDropdown() skip a full
  // rebuild when nothing about the held set changed (see there for why).
  private renderedIds: number[] | null = null;

  constructor(private host: HeldRenderHost) {}

  /** Called on attach()/flush(): collapse and drop any open dropdown/listener. */
  reset(): void {
    this.closeDropdown();
    this.expanded = false;
    this.renderedIds = null;
  }

  /** True while the caret is in one of the dropdown's editable rows - blocks
   *  the completion auto-flush the same way composer isComposing() does. */
  isEditingRow(): boolean {
    const a = this.host.getAttached();
    const el = document.activeElement;
    return !!a?.anchor && !!el && a.anchor.contains(el) && el.classList.contains("held-row");
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
    const items = this.host.itemsForActive();
    const ids = items.map((i) => i.id);
    // renderChip() re-fires on every mid-turn activity tick, not just held-set
    // changes - skip the rebuild so it can't blur a row mid-edit (editItem()
    // already keeps text in sync live).
    if (this.renderedIds && a.anchor.querySelector(".held-dropdown") &&
        ids.length === this.renderedIds.length && ids.every((id, i) => id === this.renderedIds![i])) {
      return;
    }
    this.closeDropdown();
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
        this.host.onRowBlur();
      });
      // Ctrl/Cmd+Enter saves this edit and closes the dropdown, handing focus
      // back to the composer - a second Ctrl+Enter there sends the queue
      // (Composer.handleCtrlEnter), so two presses mirrors "edit, then send".
      row.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.shiftKey || (!e.ctrlKey && !e.metaKey)) return;
        e.preventDefault();
        row.blur();
        this.expanded = false;
        this.renderChip();
        this.host.getAttached()?.focusComposer();
      });
      rows.appendChild(row);
    }
    dd.appendChild(rows);
    a.anchor.appendChild(dd);
    this.renderedIds = ids;
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
