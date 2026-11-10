// Per-chat scheduled-message chip: clock icon + count of Pending
// ScheduledKind::Message items for the active session, with a dropdown of
// Send now / Edit / Delete rows. Edit hands the item to the composer (via
// onEdit), which edits it in place and keeps it scheduled. Mechanically
// mirrors held-messages.ts (chip + floating dropdown, outside-click close) but
// renders in its own slot next to `.session-thinking` rather than reusing its
// chipSlot/anchor, so the two controllers never fight over the same DOM.
//
// Data source: schedule_list on mount/open + after every row action.
// TODO(schedule-view phase): live event — the daemon emits
// `scheduled_items_changed` internally (daemon/schedule.rs) but it isn't
// bridged to a Tauri app-side event yet, so this polls instead of subscribing.

import { invoke } from "../ipc";
import { escapeHtml } from "../escape-html";
import { showToast } from "../toast";
import type { ScheduledItem } from "../../types/ipc.generated";
import { formatFireAt, formatRecurrenceBadge } from "./schedule-picker";
import "./scheduled-chip.css";

export interface ScheduledChipOptions {
  /** `.scheduled-chip-slot` host — cleared/repopulated on every render. */
  root: HTMLElement;
  sessionId: string;
  /** Called when the user clicks a pending item's Edit (pencil) action: put
   * the item into the composer's edit mode. The item is NOT deleted. */
  onEdit: (item: ScheduledItem) => void;
}

export class ScheduledChip {
  private opts: ScheduledChipOptions;
  private items: ScheduledItem[] = [];
  private isOpen = false;
  private ddEl: HTMLElement | null = null;
  private closeOutside: ((e: MouseEvent) => void) | null = null;

  constructor(opts: ScheduledChipOptions) {
    this.opts = opts;
    void this.refresh();
  }

  destroy(): void {
    this.closeDropdown();
    this.opts.root.innerHTML = "";
  }

  async refresh(): Promise<void> {
    try {
      const all = await invoke<ScheduledItem[]>("schedule_list");
      this.items = all.filter(
        (it) =>
          it.kind.type === "message" &&
          it.kind.session_id === this.opts.sessionId &&
          (it.status.type === "pending" || it.status.type === "firing"),
      );
    } catch (err) {
      console.error("[scheduled-chip] schedule_list failed", err);
      this.items = [];
    }
    this.renderChip();
    if (this.isOpen) this.renderDropdown();
  }

  private renderChip(): void {
    const root = this.opts.root;
    if (this.items.length === 0) {
      root.innerHTML = "";
      this.closeDropdown();
      return;
    }
    const n = this.items.length;
    root.innerHTML = `
      <button class="scheduled-chip" type="button" title="${n} scheduled message${n === 1 ? "" : "s"} in this chat">
        <i class="ph ph-clock-countdown"></i><span class="scheduled-chip-count">${n}</span>
      </button>
    `;
    root.querySelector<HTMLButtonElement>(".scheduled-chip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.isOpen = !this.isOpen;
      if (this.isOpen) void this.refresh();
      else this.closeDropdown();
    });
  }

  private renderDropdown(): void {
    this.ddEl?.remove();
    const btn = this.opts.root.querySelector<HTMLElement>(".scheduled-chip");
    if (!btn) return;
    const dd = document.createElement("div");
    dd.className = "scheduled-dropdown";
    dd.innerHTML = this.items.length
      ? this.items.map((it) => this.rowHtml(it)).join("")
      : `<div class="scheduled-dropdown-empty">Nothing scheduled</div>`;
    document.body.appendChild(dd);
    this.ddEl = dd;
    this.reposition(btn);
    this.wireRows(dd);
    this.closeOutside = (e: MouseEvent) => {
      if (!dd.contains(e.target as Node) && !btn.contains(e.target as Node)) {
        this.isOpen = false;
        this.closeDropdown();
      }
    };
    setTimeout(() => {
      if (this.closeOutside) document.addEventListener("click", this.closeOutside);
    }, 0);
  }

  private reposition(anchor: HTMLElement): void {
    if (!this.ddEl) return;
    const rect = anchor.getBoundingClientRect();
    const maxLeft = window.innerWidth - this.ddEl.offsetWidth - 8;
    this.ddEl.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceAbove >= this.ddEl.offsetHeight + 8 || spaceAbove >= spaceBelow) {
      this.ddEl.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      this.ddEl.style.top = "";
    } else {
      this.ddEl.style.top = `${rect.bottom + 6}px`;
      this.ddEl.style.bottom = "";
    }
  }

  private closeDropdown(): void {
    if (this.closeOutside) {
      document.removeEventListener("click", this.closeOutside);
      this.closeOutside = null;
    }
    this.ddEl?.remove();
    this.ddEl = null;
  }

  private rowHtml(it: ScheduledItem): string {
    const preview = it.prompt.length > 80 ? `${it.prompt.slice(0, 80)}…` : it.prompt;
    const when = formatFireAt(it.fire_at);
    // Firing = claimed by a fire path but not yet resolved to Sent/Failed -
    // show it read-only (no send/edit/delete), since the send is already in
    // flight.
    const firing = it.status.type === "firing";
    const badge = it.recurrence
      ? `<span class="scheduled-row-badge">${escapeHtml(formatRecurrenceBadge(it.recurrence))}</span>`
      : "";
    const firingBadge = firing ? `<span class="scheduled-row-badge scheduled-row-badge--firing">sending&hellip;</span>` : "";
    // Mutators (send now / edit / delete) now work on remote too (ai_todo 259
    // routed schedule_fire_now/_delete/_update through HttpTransport). Only hide
    // them while a row is actively firing.
    const actions = firing ? "" : `
          <button type="button" class="scheduled-row-btn scheduled-row-send" title="Send now"><i class="ph ph-paper-plane-tilt"></i></button>
          <button type="button" class="scheduled-row-btn scheduled-row-edit" title="Edit"><i class="ph ph-pencil-simple"></i></button>
          <button type="button" class="scheduled-row-btn scheduled-row-delete" title="Delete"><i class="ph ph-trash"></i></button>`;
    return `
      <div class="scheduled-row" data-id="${escapeHtml(it.id)}">
        <div class="scheduled-row-main">
          <div class="scheduled-row-preview" title="${escapeHtml(it.prompt)}">${escapeHtml(preview)}</div>
          <div class="scheduled-row-meta"><span class="scheduled-row-when">${escapeHtml(when)}</span>${badge}${firingBadge}</div>
        </div>
        <div class="scheduled-row-actions">${actions}</div>
      </div>
    `;
  }

  private wireRows(dd: HTMLElement): void {
    dd.querySelectorAll<HTMLElement>(".scheduled-row").forEach((row) => {
      const id = row.dataset.id;
      const item = id ? this.items.find((i) => i.id === id) : undefined;
      if (!id || !item) return;
      row.querySelector(".scheduled-row-send")?.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.fireNow(id);
      });
      row.querySelector(".scheduled-row-delete")?.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.deleteItem(id);
      });
      row.querySelector(".scheduled-row-edit")?.addEventListener("click", (e) => {
        e.stopPropagation();
        this.editItem(item);
      });
    });
  }

  private async fireNow(id: string): Promise<void> {
    try {
      await invoke<void>("schedule_fire_now", { id });
      showToast("Sent now");
    } catch (err) {
      console.error("[scheduled-chip] schedule_fire_now failed", err);
      showToast(`Failed to send now: ${err}`);
    }
    await this.refresh();
  }

  private async deleteItem(id: string): Promise<void> {
    try {
      await invoke<void>("schedule_delete", { id });
    } catch (err) {
      console.error("[scheduled-chip] schedule_delete failed", err);
      showToast(`Failed to delete: ${err}`);
    }
    await this.refresh();
  }

  /** Hand the item to the composer in edit mode. The item stays scheduled the
   * whole time: cancelling the edit loses nothing, and saving re-uses its time
   * and repeat. */
  private editItem(item: ScheduledItem): void {
    this.opts.onEdit(item);
    this.isOpen = false;
    this.closeDropdown();
  }
}
