// The Subchats card's "N queued" popup: every sub the daemon holds without a process, in the order
// they will start, with what each waits for. An anchored popover (shared/chat/anchored-popover.ts,
// so outside click, Escape and viewport clamping are the app's own), not a modal. The list patches
// in place while it is open: a sub that starts leaves with its own exit and the rows below slide up,
// a row whose words changed rewrites only itself, and nothing replays the popup's own enter.
// The pure rules (order, the "starts after" words) live in shared/chat/dashboard/subs-model.ts.

import { escapeHtml } from "../../../shared/escape-html";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import { openAnchoredPopover, type AnchoredPopoverHandle } from "../../../shared/chat/anchored-popover";
import { QUEUED_FOOTNOTE, startsAfterText, type SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import "./sub-queued-popup.css";

export interface QueuedPopupDeps {
  /** The sub's avatar markup (state ring, battery, selected), the same one the card's rows wear. */
  avatar(it: SubCardItem): string;
  /** Whether this sub's peek is open, so its row reads selected. */
  isOpen(id: string): boolean;
  /** The one line the sub was briefed with ("" when it has none). Asked once per sub. */
  task(id: string): Promise<string>;
  /** A row was chosen: do what clicking that sub does elsewhere. The popup closes after. */
  pick(id: string, row: HTMLElement): void;
  /** Wire what a body-appended surface needs from the card (the avatar hover card, the right-click menu). */
  attach(pop: HTMLElement): void;
}

interface Row {
  el: HTMLElement;
  sig: string;
  leaving: boolean;
}

/** A leaving row is removed at its transitionend; this is the net for a transition that never ends
 *  (a hidden window runs none). Longer than the CSS exit. */
const LEAVE_NET_MS = 420;

export class QueuedPopup {
  private pop: HTMLElement | null = null;
  private handle: AnchoredPopoverHandle | null = null;
  private anchor: HTMLElement | null = null;
  private readonly rows = new Map<string, Row>();
  private readonly tasks = new Map<string, string>();
  private readonly asked = new Set<string>();
  private teardown: (() => void) | null = null;
  /** A pick hands focus to what it opened, so the close must not pull it back to the anchor. */
  private keepFocus = false;
  /** The popup fading out after a close; a reopen removes it first so two never overlap. */
  private fading: HTMLElement | null = null;
  /** Counts closes: a brief that lands after one is dropped instead of refilling the cache. */
  private gen = 0;

  constructor(private readonly deps: QueuedPopupDeps) {}

  get isOpen(): boolean {
    return this.pop !== null;
  }

  open(anchor: HTMLElement, items: readonly SubCardItem[]): void {
    if (this.pop || items.length === 0) return;
    this.fading?.remove();
    this.fading = null;
    this.anchor = anchor;
    this.keepFocus = false;
    const pop = document.createElement("div");
    pop.className = "sq-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Queued chats");
    pop.innerHTML = `<ul class="sq-list" role="list"></ul><p class="sq-foot">${escapeHtml(QUEUED_FOOTNOTE)}</p>`;
    document.body.appendChild(pop);
    this.pop = pop;
    this.deps.attach(pop);
    pop.addEventListener("click", (e) => this.onClick(e));
    pop.addEventListener("keydown", (e) => this.onKey(e));
    this.patch(items, true);
    this.handle = openAnchoredPopover({ anchor, el: pop, onClose: () => this.finish() });
    this.place();
    // The styles are computed at their hidden values before the class lands, so the enter transitions.
    void pop.offsetWidth;
    pop.classList.add("is-open");
    anchor.setAttribute("aria-expanded", "true");
    const again = (): void => this.place();
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    this.teardown = () => {
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", again, true);
    };
    pop.querySelector<HTMLElement>(".sx-av")?.focus({ preventScroll: true });
  }

  /** Closes through the popover's own close, so its listeners go and `finish` runs once. */
  close(): void {
    this.handle?.close();
  }

  /** Removes everything at once (the card is being torn down). */
  destroy(): void {
    this.teardown?.();
    this.teardown = null;
    this.handle?.close();
    this.pop?.remove();
    this.fading?.remove();
    this.pop = this.fading = null;
    this.rows.clear();
  }

  /** Brings the open list to `items`, in place. An empty list closes the popup. */
  patch(items: readonly SubCardItem[], initial = false): void {
    const pop = this.pop;
    if (!pop) return;
    if (items.length === 0) {
      this.close();
      return;
    }
    const list = pop.querySelector<HTMLElement>(".sq-list")!;
    const wanted = new Set(items.map((i) => i.id));
    const before = initial ? null : this.tops();
    // Focus on a row that is going moves on once the new rows exist, so it can land on one of them.
    const held = [...this.rows].some(([id, r]) => !wanted.has(id) && !r.leaving && r.el.contains(document.activeElement));
    for (const [id, row] of this.rows) if (!wanted.has(id) && !row.leaving) this.leave(id, row);

    // Walk the wanted order with a cursor over the list: a row already under it stays, anything else
    // is inserted or moved in front of it. A leaving row is skipped, so it fades where it stands.
    let cursor: Element | null = list.firstElementChild;
    let reordered = false;
    // Moving a node blurs it, so the row that held focus gets it back after the walk.
    const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".sq-row[data-sub]")?.dataset.sub ?? null;
    for (const it of items) {
      while (cursor?.classList.contains("is-leaving")) cursor = cursor.nextElementSibling;
      let row = this.rows.get(it.id);
      if (row?.leaving) {
        row.el.remove();
        this.rows.delete(it.id);
        row = undefined;
      }
      const sig = JSON.stringify([it.name, startsAfterText(it), it.ring, it.model, it.effort, this.deps.isOpen(it.id)]);
      if (!row) {
        const el = document.createElement("li");
        el.className = "sq-row";
        el.dataset.sub = it.id;
        row = { el, sig: "", leaving: false };
        this.rows.set(it.id, row);
        if (!initial) el.classList.add("is-opening");
        list.insertBefore(el, cursor);
        if (!initial) {
          void el.offsetWidth;
          el.classList.remove("is-opening");
        }
      } else if (row.el === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        list.insertBefore(row.el, cursor);
        reordered = true;
      }
      if (row.sig !== sig) {
        row.sig = sig;
        this.drawRow(row.el, it);
      }
    }
    if (held) {
      const next = pop.querySelector<HTMLElement>(".sq-row:not(.is-leaving) .sx-av");
      (next ?? this.anchor)?.focus({ preventScroll: true });
    }
    if (!held && reordered && focusedId && !pop.contains(document.activeElement)) {
      pop.querySelector<HTMLElement>(`.sq-row[data-sub="${CSS.escape(focusedId)}"]:not(.is-leaving) .sx-av`)?.focus({ preventScroll: true });
    }
    if (reordered && before) this.flip(before);
    if (!initial) this.place();
    for (const it of items) void this.loadTask(it.id);
  }

  // ---- Rows ------------------------------------------------------------------------

  private drawRow(el: HTMLElement, it: SubCardItem): void {
    // A rewrite replaces the focused avatar; the keyboard stays on the row's new one.
    const hadFocus = el.contains(document.activeElement) && (document.activeElement as HTMLElement).classList.contains("sx-av");
    const id = escapeHtml(it.id);
    el.innerHTML = `<div class="sq-clip"><div class="sx-item sq-item${this.deps.isOpen(it.id) ? " on" : ""}" data-sub="${id}" data-kind="queued"${chatMenuAttr(it.id)}>`
      + this.deps.avatar(it)
      + `<span class="sx-item-text"><b class="sx-item-name">${escapeHtml(it.name)}</b>`
      + `<span class="sx-item-why sq-task">${escapeHtml(this.tasks.get(it.id) ?? "")}</span>`
      + `<span class="sq-after"><i class="ph ph-clock" aria-hidden="true"></i><span>${escapeHtml(startsAfterText(it))}</span></span></span></div></div>`;
    if (this.tasks.get(it.id)) el.querySelector(".sq-task")?.classList.add("is-ready");
    if (hadFocus) el.querySelector<HTMLElement>(".sx-av")?.focus({ preventScroll: true });
  }

  /** The line a sub was briefed with, fetched once and faded in when it lands, so the row never
   *  changes height for it (the line's room is always reserved). */
  private async loadTask(id: string): Promise<void> {
    if (this.asked.has(id)) return;
    this.asked.add(id);
    const gen = this.gen;
    let text = "";
    try {
      text = (await this.deps.task(id)).trim();
    } catch {
      // The brief is best effort: the row is complete without it.
    }
    if (gen !== this.gen) return;
    this.tasks.set(id, text);
    const slot = this.rows.get(id)?.el.querySelector<HTMLElement>(".sq-task");
    if (!slot || !text) return;
    slot.textContent = text;
    slot.classList.add("is-ready");
  }

  private leave(id: string, row: Row): void {
    row.leaving = true;
    const el = row.el;
    el.classList.add("is-leaving");
    el.querySelectorAll<HTMLElement>("button, [tabindex]").forEach((b) => { b.tabIndex = -1; });
    let done = false;
    const remove = (): void => {
      if (done) return;
      done = true;
      el.remove();
      if (this.rows.get(id) === row) this.rows.delete(id);
      this.place();
    };
    el.addEventListener("transitionend", (e) => {
      if (e.target === el && (e.propertyName === "grid-template-rows" || e.propertyName === "opacity")) remove();
    });
    setTimeout(remove, LEAVE_NET_MS);
  }

  private tops(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, r] of this.rows) if (!r.leaving) out.set(id, r.el.getBoundingClientRect().top);
    return out;
  }

  /** Rows that changed place slide from where they were instead of jumping. */
  private flip(before: Map<string, number>): void {
    for (const [id, r] of this.rows) {
      const was = before.get(id);
      if (was === undefined || r.leaving) continue;
      const d = was - r.el.getBoundingClientRect().top;
      if (Math.abs(d) < 1) continue;
      r.el.style.transition = "none";
      r.el.style.transform = `translateY(${d}px)`;
      void r.el.offsetWidth;
      r.el.style.transition = "";
      r.el.style.transform = "";
    }
  }

  // ---- Placement and input ----------------------------------------------------------

  /** The popover helper flips and clamps it off the anchor; the enter then grows from the anchor's side. */
  private place(): void {
    const pop = this.pop;
    const anchor = this.anchor;
    if (!pop || !anchor || !this.handle) return;
    this.handle.reposition();
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    pop.style.setProperty("--sq-ox", `${Math.round(a.left + a.width / 2 - p.left)}px`);
    pop.style.setProperty("--sq-oy", p.top >= a.bottom - 1 ? "0px" : `${Math.round(p.height)}px`);
  }

  private onClick(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".sx-item[data-sub]");
    if (!row?.dataset.sub || row.closest(".is-leaving")) return;
    this.deps.pick(row.dataset.sub, row);
    this.keepFocus = true;
    this.close();
  }

  /** Arrow keys walk the avatars; Enter and Space on a focused avatar are its own click. */
  private onKey(e: KeyboardEvent): void {
    // Space presses the focused avatar: keep it from the composer's stray-input relay on the document,
    // which would type it into the chat's message box instead (composer-stray-input.ts).
    if (e.key === " " && (e.target as HTMLElement).closest("button")) e.stopPropagation();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const avs = [...(this.pop?.querySelectorAll<HTMLElement>(".sq-row:not(.is-leaving) .sx-av") ?? [])];
    if (avs.length === 0) return;
    e.preventDefault();
    const at = avs.indexOf(document.activeElement as HTMLElement);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    avs[(at === -1 ? (delta > 0 ? 0 : avs.length - 1) : (at + delta + avs.length) % avs.length)]?.focus();
  }

  /** The popover closed (outside click, Escape or `close`): fade out, then remove. */
  private finish(): void {
    const pop = this.pop;
    const anchor = this.anchor;
    if (!pop) return;
    this.teardown?.();
    this.teardown = null;
    this.pop = null;
    this.handle = null;
    this.rows.clear();
    // A brief that failed to load, or was not written yet, is asked again at the next open.
    this.tasks.clear();
    this.asked.clear();
    this.gen++;
    // Focus left in the popup (Escape, or a pick) goes back to what opened it. An outside click moves
    // it to the clicked thing after this runs, so it is never stolen.
    const inside = pop.contains(document.activeElement) || document.activeElement === document.body;
    if (anchor) {
      anchor.setAttribute("aria-expanded", "false");
      const hidden = anchor.closest("[inert]") !== null;
      if (inside && !hidden && !this.keepFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    }
    pop.classList.remove("is-open");
    pop.classList.add("is-closing");
    this.fading = pop;
    let done = false;
    const remove = (): void => {
      if (done) return;
      done = true;
      pop.remove();
      if (this.fading === pop) this.fading = null;
    };
    pop.addEventListener("transitionend", (e) => {
      if (e.target === pop && e.propertyName === "opacity") remove();
    });
    setTimeout(remove, LEAVE_NET_MS);
  }
}
