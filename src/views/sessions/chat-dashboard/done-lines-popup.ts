// The Done card's "earlier" popup: the finished features past the card's own newest few, last day
// at least, a divider per release (a divider opens that release's What's new) and a search box. An
// anchored popover (shared/chat/anchored-popover.ts, so outside click, Escape and viewport clamping
// are the app's own). Its lines are the card's lines (done-lines-html.ts), opened in place the same
// way; a data update redraws the list only when the markup changed.

import { openAnchoredPopover, type AnchoredPopoverHandle } from "../../../shared/chat/anchored-popover";
import { doneMatches, groupByRelease, type ReleaseDate } from "../../../shared/chat/dashboard/done-model";
import type { FeatureRow } from "../../../shared/chat/dashboard/features-model";
import { whatsNewReleaseHtml } from "../whats-new/whats-new";
import { fillAgo } from "./done-card";
import { lineLinkAct } from "./features-card";
import { popupListHtml, type DoneOpen } from "./done-lines-html";
import { applyOpen, nextOpen, soleChat } from "./done-lines-open";
import { attachSubHover, type SubHoverResolver } from "./sub-hover";

export interface DonePopupDeps {
  /** The clock button that opened it: the popover hangs off it and focus returns to it. */
  anchor: HTMLElement;
  rows: readonly FeatureRow[];
  releases: readonly ReleaseDate[];
  hoverOf: SubHoverResolver;
  onClose(): void;
}

export class DonePopup {
  private pop: HTMLElement | null = null;
  private handle: AnchoredPopoverHandle | null = null;
  private anchor: HTMLElement | null = null;
  private rows: readonly FeatureRow[];
  private releases: readonly ReleaseDate[];
  private query = "";
  private open: DoneOpen = { feat: null, chat: null };
  private listHtml = "";
  private modal: HTMLElement | null = null;

  constructor(private readonly deps: DonePopupDeps) {
    this.rows = deps.rows;
    this.releases = deps.releases;
  }

  show(): void {
    if (this.pop) return;
    const anchor = this.deps.anchor;
    this.anchor = anchor;
    const pop = document.createElement("div");
    pop.className = "dl-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Earlier finished features");
    pop.innerHTML = `<label class="dl-search"><i class="ph ph-magnifying-glass"></i><input type="search" class="dl-q" placeholder="Search finished features" aria-label="Search finished features" autocomplete="off" spellcheck="false"></label>`
      + `<div class="dl-pop-list"></div>`;
    document.body.appendChild(pop);
    this.pop = pop;
    pop.addEventListener("click", (e) => this.onClick(e));
    pop.addEventListener("input", (e) => {
      const t = e.target as HTMLElement;
      if (!t.classList.contains("dl-q")) return;
      this.query = (t as HTMLInputElement).value;
      this.drawList();
    });
    pop.addEventListener("keydown", (e) => this.onKey(e));
    attachSubHover(pop, this.deps.hoverOf, { selector: "[data-chat-menu-id]", idOf: (n) => n.dataset.chatMenuId });
    this.drawList();
    this.handle = openAnchoredPopover({ anchor, el: pop, onClose: () => this.finish() });
    this.handle.reposition();
    // The styles are computed at their hidden values before the class lands, so the enter transitions.
    void pop.offsetWidth;
    pop.classList.add("is-open");
    anchor.setAttribute("aria-expanded", "true");
    pop.querySelector<HTMLElement>(".dl-q")?.focus({ preventScroll: true });
  }

  /** New rows while the popup is open: the list redraws only when its markup changed. */
  update(rows: readonly FeatureRow[], releases: readonly ReleaseDate[]): void {
    this.rows = rows;
    this.releases = releases;
    if (!this.pop) return;
    if (rows.length === 0) {
      this.close();
      return;
    }
    this.drawList();
    this.handle?.reposition();
  }

  close(): void {
    this.closeModal();
    this.handle?.close();
  }

  private drawList(): void {
    const pop = this.pop;
    const list = pop?.querySelector<HTMLElement>(".dl-pop-list");
    if (!pop || !list) return;
    const shown = this.rows.filter((r) => doneMatches(r, this.query));
    if (this.open.feat !== null && !shown.some((r) => r.key === this.open.feat)) this.open = { feat: null, chat: null };
    const html = popupListHtml(groupByRelease(shown, this.releases), this.open);
    if (html !== this.listHtml) {
      list.innerHTML = html;
      this.listHtml = html;
      applyOpen(list, this.open);
    }
    fillAgo(list);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!t || !this.pop?.contains(t)) return;
    if ((e.target as HTMLElement).closest("a.pf-lk")) return;
    const act = t.dataset.act ?? "";
    // The popup sits outside the dashboard's click delegate, so the line's id icons act here.
    if (act === "pf-todo" || act === "pf-ticket") {
      lineLinkAct(act, t);
      return;
    }
    if (act === "dl-whatsnew") {
      this.showRelease(t.dataset.ver ?? "");
      return;
    }
    if (act !== "dl-open" && act !== "dl-chat") return;
    this.open = nextOpen(this.open, act, t.dataset.feat ?? "", t.dataset.chat ?? "", soleChat(this.rows, t.dataset.feat ?? ""));
    const list = this.pop.querySelector<HTMLElement>(".dl-pop-list");
    if (list) applyOpen(list, this.open);
    // The settled markup of this choice is what the next data redraw compares with.
    this.listHtml = popupListHtml(groupByRelease(this.rows.filter((r) => doneMatches(r, this.query)), this.releases), this.open);
    this.handle?.reposition();
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    // The composer's stray-input relay on the document would type these into the chat's message box.
    if (e.key === " " && !t.matches("input")) e.stopPropagation();
    if ((e.key === "Enter" || e.key === " ") && t.matches(".pf-row, .dl-chat")) {
      e.preventDefault();
      e.stopPropagation();
      t.click();
    }
  }

  // ---- What's new for a release ---------------------------------------------------------------

  private showRelease(version: string): void {
    const html = whatsNewReleaseHtml(version);
    if (!html) return;
    this.closeModal();
    // The popover's outside-click and Escape listeners would treat the dialog as outside, so the popup
    // closes first and the dialog stands alone.
    this.handle?.close();
    const modal = document.createElement("div");
    modal.className = "dl-wn";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    // A click on the dialog's text lands focus on the dialog itself, so Escape and Tab still reach it.
    modal.tabIndex = -1;
    modal.setAttribute("aria-label", `What's new in v${version}`);
    modal.innerHTML = `<div class="dl-wn-card">${html}<button type="button" class="dl-wn-x" data-act="dl-wn-close" aria-label="Close what's new"><i class="ph ph-x"></i></button></div>`;
    modal.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === modal || t.closest("[data-act='dl-wn-close']")) this.closeModal();
    });
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.closeModal();
      } else if (e.key === "Tab") {
        // aria-modal: the close button is the only stop, so Tab stays on it.
        e.preventDefault();
      }
    });
    document.body.appendChild(modal);
    this.modal = modal;
    void modal.offsetWidth;
    modal.classList.add("is-open");
    modal.querySelector<HTMLElement>(".dl-wn-x")?.focus({ preventScroll: true });
  }

  /** Removes the What's new dialog, which outlives the popup that opened it. */
  dismissDialog(): void {
    this.closeModal();
  }

  private closeModal(): void {
    const modal = this.modal;
    if (!modal) return;
    this.modal = null;
    const anchor = this.anchor;
    if (anchor?.isConnected && !anchor.closest("[inert]") && modal.contains(document.activeElement)) anchor.focus({ preventScroll: true });
    modal.classList.remove("is-open");
    let done = false;
    const remove = (): void => {
      if (done) return;
      done = true;
      modal.remove();
    };
    modal.addEventListener("transitionend", (e) => {
      if (e.target === modal) remove();
    });
    window.setTimeout(remove, 400);
  }

  /** The popover closed (outside click, Escape or `close`): fade out, then remove. */
  private finish(): void {
    const pop = this.pop;
    if (!pop) return;
    this.pop = null;
    this.handle = null;
    const anchor = this.anchor;
    if (anchor) {
      anchor.setAttribute("aria-expanded", "false");
      const inside = pop.contains(document.activeElement) || document.activeElement === document.body;
      if (inside && anchor.isConnected && !anchor.closest("[inert]")) anchor.focus({ preventScroll: true });
    }
    pop.classList.remove("is-open");
    pop.classList.add("is-closing");
    let done = false;
    const remove = (): void => {
      if (done) return;
      done = true;
      pop.remove();
    };
    pop.addEventListener("transitionend", (e) => {
      if (e.target === pop && e.propertyName === "opacity") remove();
    });
    window.setTimeout(remove, 420);
    this.deps.onClose();
  }
}
