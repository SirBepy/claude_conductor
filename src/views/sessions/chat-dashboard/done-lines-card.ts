// The Done card on a main chat: the features the chat's subs finished, drawn as the Plan card's own
// lines (features-html.ts) under a header of the same type. The newest few sit in the card, which
// opens and folds from the chevron at its right edge; the rest of the last day wait in a popup
// (done-lines-popup.ts) with a divider per release.
//
// Owns its DOM inside the zone's `.dl-host`, like FeaturesCard owns `.pf-host`: a data redraw
// reconciles the lines by key (a new one enters, a gone one leaves, an unchanged one is kept), and
// opening a card, a line or a chat's steps patches classes in place, so every choice animates and
// a redraw that changes nothing paints nothing.

import { tierLabel } from "../../../shared/model-name";
import { doneWindow, newSince, type ReleaseDate } from "../../../shared/chat/dashboard/done-model";
import type { FeatureChat, FeatureRow } from "../../../shared/chat/dashboard/features-model";
import { fillAgo } from "./done-card";
import { doneHeadHtml, doneLineHtml, type DoneHeadState, type DoneOpen } from "./done-lines-html";
import { DonePopup } from "./done-lines-popup";
import { applyOpen, nextOpen } from "./done-lines-open";
import type { SubHoverResolver } from "./sub-hover";
import "./features-card.css";
import "./done-lines.css";

export interface DoneLinesDeps {
  /** The releases the What's new entries name, for the popup's dividers. */
  releases(): readonly ReleaseDate[];
  /** The clock; a spec pins it. */
  now?(): number;
}

interface Node {
  el: HTMLElement;
  html: string;
}

export class DoneLinesCard {
  private host: HTMLElement | null = null;
  private rows: readonly FeatureRow[] = [];
  /** The card shows its lines. Folded on a fresh window, as the board has it; in memory only. */
  private shown = false;
  /** When Joe last looked: the "N new" badge counts what finished after it. */
  private seenAt: number;
  private open: DoneOpen = { feat: null, chat: null };
  private headHtml = "";
  private readonly nodes = new Map<string, Node>();
  private popup: DonePopup | null = null;
  /** A first draw puts its lines in place; only a later one enters a new line. */
  private drawn = false;
  private disposed = false;
  /** The pending "open fold finished" listener; a fold shut before it fires drops it. */
  private settle: ((e: Event) => void) | null = null;

  constructor(private readonly deps: DoneLinesDeps) {
    this.seenAt = this.clock();
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Draws the card into its host; `rows` is newest first. */
  update(host: HTMLElement, rows: readonly FeatureRow[]): void {
    if (this.host !== host) {
      // The zone's shell was rebuilt around a new host: the old nodes went with it.
      this.nodes.clear();
      this.headHtml = "";
      this.host = host;
      host.innerHTML = `<div class="dl-fold"><div class="dl-fold-clip"><div class="dl-rows"></div></div></div>`;
      host.classList.toggle("is-open", this.shown);
      host.querySelector(".dl-fold-clip")?.classList.toggle("is-settled", this.shown);
    }
    this.rows = rows;
    this.draw();
    this.popup?.update(this.restRows(), this.deps.releases());
  }

  /** The chat is no main chat any more, or has nothing finished: forget the DOM. */
  detach(): void {
    this.popup?.close();
    this.popup = null;
    this.host = null;
    this.rows = [];
    this.nodes.clear();
    this.headHtml = "";
    this.drawn = false;
    this.open = { feat: null, chat: null };
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
  }

  /** The hover card's lines for a trail icon or chat row, as the Plan card's own icons give. */
  readonly hoverOf: SubHoverResolver = (id) => {
    const c = this.chatOf(id);
    if (!c?.item.hover) return null;
    return { name: c.name, tier: tierLabel(c.item.model, c.item.effort), kind: c.item.kind, hover: c.item.hover, startedAt: c.item.startedAt };
  };

  private chatOf(id: string): FeatureChat | null {
    for (const r of this.rows) {
      const c = r.chats.find((x) => x.id === id);
      if (c) return c;
    }
    return null;
  }

  private window(): { inline: FeatureRow[]; rest: FeatureRow[] } {
    return doneWindow(this.rows, this.clock());
  }

  private restRows(): FeatureRow[] {
    return this.window().rest;
  }

  private headState(): DoneHeadState {
    const { inline, rest } = this.window();
    return { shown: this.shown, fresh: newSince([...inline, ...rest], this.seenAt), hasMore: rest.length > 0 };
  }

  // ---- Drawing ------------------------------------------------------------------------------

  private draw(): void {
    const host = this.host;
    if (!host || this.disposed) return;
    // A line that left the window while open closes with it.
    const { inline } = this.window();
    if (this.open.feat !== null && !inline.some((r) => r.key === this.open.feat)) this.open = { feat: null, chat: null };
    this.drawHead(host);
    this.reconcile(host, inline);
    this.syncFold(host);
    fillAgo(host);
  }

  private drawHead(host: HTMLElement): void {
    const html = doneHeadHtml(this.headState());
    if (html === this.headHtml) return;
    const hadFocus = host.querySelector<HTMLElement>(".dl-h")?.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const act = hadFocus?.dataset.act;
    const cls = hadFocus?.className;
    const old = host.querySelector(".dl-h");
    const t = document.createElement("template");
    t.innerHTML = html;
    const fresh = t.content.firstElementChild as HTMLElement;
    // The clock button anchors the open popup: the same node stays, so the popup keeps its place.
    const keep = old?.querySelector(".dl-earlier");
    const next = fresh.querySelector(".dl-earlier");
    if (keep && next && keep.outerHTML.replace(/ aria-expanded="[^"]*"/, "") === next.outerHTML.replace(/ aria-expanded="[^"]*"/, "")) next.replaceWith(keep);
    if (old) old.replaceWith(fresh);
    else host.prepend(fresh);
    this.headHtml = html;
    if (act && cls) fresh.querySelector<HTMLElement>(`.${cls.split(" ")[0]}[data-act="${act}"]`)?.focus({ preventScroll: true });
  }

  private syncFold(host: HTMLElement): void {
    const rows = host.querySelector<HTMLElement>(".dl-rows");
    if (!rows) return;
    if (this.shown) rows.removeAttribute("inert");
    else rows.setAttribute("inert", "");
  }

  /** Keeps the line nodes the new rows still match, replaces a changed one in place (settled, no
   *  motion), enters a new one and lets a gone one leave. */
  private reconcile(host: HTMLElement, inline: readonly FeatureRow[]): void {
    const rowsEl = host.querySelector<HTMLElement>(".dl-rows");
    if (!rowsEl) return;
    const wanted = new Set(inline.map((r) => r.key));
    for (const [key, node] of this.nodes) {
      if (wanted.has(key)) continue;
      this.nodes.delete(key);
      this.leave(node.el);
    }
    let prev: Element | null = null;
    for (const row of inline) {
      const html = doneLineHtml(row, this.open);
      const have = this.nodes.get(row.key);
      let el: HTMLElement;
      if (have && have.html === html) {
        el = have.el;
      } else {
        el = this.slotFor(html);
        if (have) have.el.replaceWith(el);
        else if (this.drawn && this.shown) this.enter(el);
        this.nodes.set(row.key, { el, html });
      }
      const at: Element | null = prev ? prev.nextElementSibling : rowsEl.firstElementChild;
      if (el !== at) rowsEl.insertBefore(el, at);
      prev = el;
    }
    applyOpen(rowsEl, this.open);
    this.drawn = true;
  }

  private slotFor(html: string): HTMLElement {
    const slot = document.createElement("div");
    // Settled: its tooltips may hang over the slot's edge. A line that enters or leaves clips while it moves.
    slot.className = "dl-slot is-settled";
    slot.innerHTML = `<div class="dl-slot-clip">${html}</div>`;
    return slot;
  }

  /** A new line opens from nothing: its slot starts shut and one frame later is let go. */
  private enter(el: HTMLElement): void {
    el.classList.remove("is-settled");
    el.classList.add("is-new");
    const settle = (): void => el.classList.add("is-settled");
    el.addEventListener("transitionend", (e) => {
      if (e.target === el && (e as TransitionEvent).propertyName === "grid-template-rows") settle();
    });
    window.setTimeout(settle, 500);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("is-new")));
  }

  /** A gone line folds away where it stood and is removed once the fold ran. */
  private leave(el: HTMLElement): void {
    el.classList.remove("is-settled");
    el.classList.add("is-leaving");
    const done = (): void => el.remove();
    el.addEventListener("transitionend", (e) => {
      if (e.target === el && (e as TransitionEvent).propertyName === "grid-template-rows") done();
    });
    window.setTimeout(done, 600);
  }

  /** Records the settled markup of every kept line after a patch in place, so the next data redraw
   *  compares like with like and paints nothing for a choice already shown. */
  private syncCache(): void {
    for (const row of this.window().inline) {
      const node = this.nodes.get(row.key);
      if (node) node.html = doneLineHtml(row, this.open);
    }
  }

  // ---- Clicks -------------------------------------------------------------------------------

  /** Handles a click on one of the card's `data-act`s; true when it was one of theirs. */
  act(name: string, t: HTMLElement): boolean {
    const host = this.host;
    if (!host) return false;
    switch (name) {
      case "dl-toggle":
        this.toggle(host);
        return true;
      case "dl-earlier":
        this.openPopup(t);
        return true;
      case "dl-open":
      case "dl-chat": {
        this.open = nextOpen(this.open, name, t.dataset.feat ?? "", t.dataset.chat ?? "");
        const rowsEl = host.querySelector<HTMLElement>(".dl-rows");
        if (rowsEl) applyOpen(rowsEl, this.open);
        this.syncCache();
        return true;
      }
      default:
        return false;
    }
  }

  private toggle(host: HTMLElement): void {
    this.shown = !this.shown;
    // Opening or folding the card is a look: what finished before now is no longer new.
    this.seenAt = this.clock();
    if (!this.shown) this.open = { feat: null, chat: null };
    const clip = host.querySelector<HTMLElement>(".dl-fold-clip");
    const fold = host.querySelector<HTMLElement>(".dl-fold");
    host.classList.toggle("is-open", this.shown);
    if (this.settle) fold?.removeEventListener("transitionend", this.settle);
    this.settle = null;
    if (this.shown) {
      // Row tooltips hang over the card's edge: the fold clips only while it moves.
      const settle = (e: Event): void => {
        if ((e as TransitionEvent).propertyName !== "grid-template-rows") return;
        clip?.classList.add("is-settled");
        fold?.removeEventListener("transitionend", settle);
        if (this.settle === settle) this.settle = null;
      };
      this.settle = settle;
      fold?.addEventListener("transitionend", settle);
    } else {
      clip?.classList.remove("is-settled");
    }
    const rowsEl = host.querySelector<HTMLElement>(".dl-rows");
    if (rowsEl) applyOpen(rowsEl, this.open);
    this.syncCache();
    this.drawHead(host);
    this.syncFold(host);
  }

  private openPopup(anchor: HTMLElement): void {
    if (this.popup) {
      this.popup.close();
      return;
    }
    const popup = new DonePopup({
      anchor,
      rows: this.restRows(),
      releases: this.deps.releases(),
      hoverOf: this.hoverOf,
      onClose: () => { if (this.popup === popup) this.popup = null; },
    });
    this.popup = popup;
    popup.show();
  }
}
