// The Subchats card (docs/chat-dashboard-design.md, "Subchats card redesign"): the live subs of
// this chat. A sub that needs Joe or is not progressing is a tinted row with one line saying why;
// a working sub is a quiet avatar in a strip. A click opens that sub's mini dashboard (sub-peek.ts)
// as a floating card Joe can drag, and several can stay open at once. Like the Answers card it owns
// its DOM inside a fixed host, so a re-derive never wipes a typed message or an open gallery. The
// rules for who is listed live in shared/chat/dashboard/subs-model.ts.

import { escapeHtml } from "../../../shared/escape-html";
import {
  countSubs, isStuckKind, STUCK_ROWS_SHOWN, subCountsText, subStepLabel, subWhy,
  type SubCardItem, type SubsState,
} from "../../../shared/chat/dashboard/subs-model";
import type { Instance } from "../../../types/ipc.generated";
import { invoke } from "../../../shared/ipc";
import { ringHtml, type RingSpec } from "../sidebar-ring";
import type { SubHoverInput } from "../sidebar-hover-card-html";
import { modelBatteryHtml } from "../sidebar-row-visuals";
import { subGlyphHtml, subInitials } from "../sub-list";
import { tierLabel } from "../../../shared/model-name";
import { attachSubHover } from "./sub-hover";
import { isMirrored } from "../sessions-helpers";
import { openSubCardMenu } from "./sub-card-menu";
import { SubPeek } from "./sub-peek";
import "./subs-card.css";

export { GALLERY_PAGE } from "./sub-peek";

export interface SubsCardDeps {
  mainId(): string;
  cwd(): string | null;
  sessions(): readonly Instance[];
  /** Read this sub in place in the main chat's window. */
  openSub(subId: string): void | Promise<void>;
  /** Ask the dashboard to derive again (a pin or a pause changed a row). */
  rerender(): void;
}

interface PreviewRef { slug: string; title: string }

/** Seconds between data refreshes while a peek is open (the clock ticks every second). */
const REFRESH_EVERY = 5;

/** Pixels each further peek is offset from the last, so a stack of them stays readable. */
const CASCADE = 26;

/** No native `title`: the hover card (sub-hover.ts) says it, and two tooltips on one avatar would stack. */
export function avatarHtml(it: SubCardItem, ring: string, selected: boolean): string {
  const name = escapeHtml(it.name);
  return `<button type="button" class="sx-av${selected ? " on" : ""}" data-sub="${escapeHtml(it.id)}" data-kind="${it.kind}" aria-pressed="${selected}" aria-label="${name}, ${escapeHtml(it.progress)}">`
    + `<span class="sx-face">${escapeHtml(subInitials(it.name))}${ring}</span>${subGlyphHtml(it.kind)}${modelBatteryHtml(it.model, it.effort)}</button>`;
}

/** A stuck sub's row: its avatar (so the hover card and right-click menu still work), name, the
 *  one line saying why, and its step. */
export function stuckRowHtml(it: SubCardItem, av: string, open: boolean): string {
  return `<div class="sx-item${open ? " on" : ""}" data-sub="${escapeHtml(it.id)}" data-kind="${it.kind}">${av}`
    + `<span class="sx-item-text"><b class="sx-item-name">${escapeHtml(it.name)}</b><span class="sx-item-why">${escapeHtml(subWhy(it))}</span></span>`
    + `<span class="sx-item-meta">${escapeHtml(subStepLabel(it))}</span></div>`;
}

/** A peek grows (gallery, brief) after it is placed, so its height is capped to the room below its top
 *  edge and it scrolls inside, instead of running off the window. */
function fitHeight(el: HTMLElement): void {
  el.style.maxHeight = `${Math.max(160, window.innerHeight - el.offsetTop - 8)}px`;
}

export class SubsCard {
  private host: HTMLElement | null = null;
  private state: SubsState | null = null;
  /** The open peeks, oldest first. */
  private readonly peeks = new Map<string, SubPeek>();
  private earlierOpen = false;
  private moreOpen = false;
  private zTop = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private rowSig = "";

  constructor(private readonly deps: SubsCardDeps) {}

  /** Draws `state` into `host` (the zone's fixed element). A new host (the zone
   *  was drawn again after being empty) starts the card over. */
  update(host: HTMLElement, state: SubsState | null): void {
    if (this.host !== host) {
      this.closeAll();
      this.host = host;
      this.rowSig = "";
      host.innerHTML = `<div class="sx-counts"></div><div class="sx-rows"></div><div class="sx-row"></div><div class="sx-earlier-row" hidden></div>`;
      host.addEventListener("click", (e) => this.onClick(e));
      host.addEventListener("contextmenu", (e) => this.onContext(e));
      host.addEventListener("pointerdown", (e) => this.onPointerDown(e));
      attachSubHover(host, (id) => this.hoverInput(id));
    }
    this.state = state;
    for (const id of [...this.peeks.keys()]) if (!this.item(id)) this.closePeek(id);
    this.renderRow();
    for (const p of this.peeks.values()) p.patch();
    this.syncTimer();
  }

  /** The zone is gone (the card has nothing to show). */
  detach(): void {
    this.closeAll();
    this.host = null;
    this.state = null;
    this.stopTimer();
  }

  dispose(): void {
    this.detach();
  }

  private item(id: string): SubCardItem | undefined {
    return [...(this.state?.shown ?? []), ...(this.state?.earlier ?? [])].find((i) => i.id === id);
  }

  private instance(id: string): Instance | undefined {
    return this.deps.sessions().find((s) => s.session_id === id);
  }

  /** The avatar hover card's input, read fresh on every tick so it tracks the sub while it is up. */
  private hoverInput(id: string): Omit<SubHoverInput, "contextPct" | "now"> | null {
    const it = this.item(id);
    if (!it?.hover) return null;
    return { name: it.name, tier: tierLabel(it.model, it.effort), kind: it.kind, hover: it.hover, startedAt: it.startedAt };
  }

  // ---- Rows and strip ------------------------------------------------------------

  private renderRow(): void {
    const host = this.host;
    if (!host || !this.state) return;
    const { shown, earlier } = this.state;
    const open = new Set(this.peeks.keys());
    const why = (i: SubCardItem): string => subWhy(i, Math.floor(Date.now() / 60_000) * 60_000);
    // The ring's markup carries an animation phase that changes on every build,
    // so the card is only rebuilt when what it draws changed.
    const sig = JSON.stringify([
      shown.map((i) => [i.id, i.kind, i.closing, i.model, i.effort, i.progress, i.ring, isStuckKind(i.kind) ? why(i) : "", subStepLabel(i)]),
      earlier.map((i) => [i.id, i.kind, i.ring]),
      [...open], this.earlierOpen, this.moreOpen,
    ]);
    if (sig === this.rowSig) return;
    this.rowSig = sig;
    const av = (i: SubCardItem): string => avatarHtml(i, ringHtml(i.ring as RingSpec), open.has(i.id));
    const stuck = shown.filter((i) => isStuckKind(i.kind));
    const working = shown.filter((i) => !isStuckKind(i.kind));
    const rows = this.moreOpen ? stuck : stuck.slice(0, STUCK_ROWS_SHOWN);
    const hidden = stuck.length - rows.length;

    const counts = countSubs(shown);
    const stuckTotal = counts ? counts.queued + counts.paused + counts.limited + counts.stopped : 0;
    host.querySelector<HTMLElement>(".sx-counts")!.textContent = counts
      ? [counts.working ? `${counts.working} working` : "", counts.asking ? `${counts.asking} asking` : "", stuckTotal ? `${stuckTotal} stuck or waiting` : ""].filter(Boolean).join(" · ") || subCountsText(counts)
      : "";

    host.querySelector<HTMLElement>(".sx-rows")!.innerHTML = rows.map((i) => stuckRowHtml(i, av(i), open.has(i.id))).join("")
      + (stuck.length > STUCK_ROWS_SHOWN
        ? `<button type="button" class="sx-more" data-act="more-stuck">${this.moreOpen ? "Show fewer" : `+${hidden} more`}</button>` : "");

    const more = earlier.length > 0
      ? `<button type="button" class="sx-earlier${this.earlierOpen ? " on" : ""}" data-act="earlier" aria-expanded="${this.earlierOpen}">+${earlier.length} earlier</button>` : "";
    const strip = host.querySelector<HTMLElement>(".sx-row")!;
    strip.hidden = working.length === 0 && more === "";
    strip.innerHTML = (working.length > 0 && stuck.length > 0 ? `<span class="sx-strip-lab">Working</span>` : "") + working.map(av).join("") + more;
    const list = host.querySelector<HTMLElement>(".sx-earlier-row")!;
    list.hidden = !(this.earlierOpen && earlier.length > 0);
    list.innerHTML = this.earlierOpen ? earlier.map(av).join("") : "";
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const own = t.closest<HTMLElement>(".sx-det");
    if (own?.dataset.sub) {
      this.raise(own);
      if (t.closest("[data-act='peek-close']")) this.closePeek(own.dataset.sub);
      else this.peeks.get(own.dataset.sub)?.handleClick(t);
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]");
    if (act?.dataset.act === "earlier") {
      this.earlierOpen = !this.earlierOpen;
      this.rowSig = "";
      this.renderRow();
      return;
    }
    if (act?.dataset.act === "more-stuck") {
      this.moreOpen = !this.moreOpen;
      this.rowSig = "";
      this.renderRow();
      return;
    }
    const target = t.closest<HTMLElement>("[data-sub]");
    if (target?.dataset.sub) this.toggle(target.dataset.sub, target);
  }

  // ---- Peeks -----------------------------------------------------------------------

  private toggle(id: string, anchor: HTMLElement): void {
    if (this.peeks.has(id)) this.closePeek(id);
    else this.openPeek(id, anchor);
    this.rowSig = "";
    this.renderRow();
    this.syncTimer();
  }

  private openPeek(id: string, anchor: HTMLElement): void {
    const host = this.host;
    if (!host) return;
    const peek = new SubPeek(id, {
      mainId: () => this.deps.mainId(),
      cwd: () => this.deps.cwd(),
      item: (sid) => this.item(sid),
      instance: (sid) => this.instance(sid),
    });
    // position: fixed, so the card sits over the neighbouring column instead of growing this one.
    host.appendChild(peek.el);
    this.peeks.set(id, peek);
    this.place(peek.el, anchor);
    this.raise(peek.el);
    peek.start();
  }

  /** First to the right of the card, level with what was clicked; each further one steps down and
   *  right so none hides another. Kept inside the window. */
  private place(el: HTMLElement, anchor: HTMLElement): void {
    const host = this.host!.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const n = this.peeks.size - 1;
    const w = el.offsetWidth || 320;
    const h = el.offsetHeight || 260;
    const left = Math.max(8, Math.min(host.right + 12 + n * CASCADE, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(a.top + n * CASCADE, window.innerHeight - h - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    fitHeight(el);
  }

  private raise(el: HTMLElement): void {
    this.zTop += 1;
    el.style.zIndex = String(10 + this.zTop);
  }

  private closePeek(id: string): void {
    this.peeks.get(id)?.destroy();
    this.peeks.delete(id);
    this.rowSig = "";
    if (this.host) {
      this.renderRow();
      this.syncTimer();
    }
  }

  private closeAll(): void {
    for (const p of this.peeks.values()) p.destroy();
    this.peeks.clear();
  }

  /** Drag by the peek's top line (not its buttons or the context chip). */
  private onPointerDown(e: PointerEvent): void {
    const top = (e.target as HTMLElement).closest<HTMLElement>(".sx-det-top");
    if (!top || (e.target as HTMLElement).closest("button, .sx-det-ctx") || e.button !== 0) return;
    const el = top.closest<HTMLElement>(".sx-det");
    if (!el) return;
    this.raise(el);
    const startX = e.clientX - el.offsetLeft;
    const startY = e.clientY - el.offsetTop;
    const move = (m: PointerEvent): void => {
      el.style.left = `${Math.max(0, Math.min(m.clientX - startX, window.innerWidth - 80))}px`;
      el.style.top = `${Math.max(0, Math.min(m.clientY - startY, window.innerHeight - 40))}px`;
      fitHeight(el);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.classList.remove("is-dragging");
    };
    el.classList.add("is-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  }

  // ---- Right-click menu ------------------------------------------------------------

  private onContext(e: MouseEvent): void {
    const av = (e.target as HTMLElement).closest<HTMLElement>(".sx-av");
    const it = av?.dataset.sub ? this.item(av.dataset.sub) : undefined;
    if (!av || !it) return;
    e.preventDefault();
    const inst = this.instance(it.id);
    const mainId = this.deps.mainId();
    openSubCardMenu({
      subId: it.id,
      anchor: av,
      model: it.model,
      effort: it.effort,
      queued: it.kind === "queued",
      finished: it.kind === "finished",
      busy: inst?.busy === true,
      frozen: inst?.frozen === true,
      pinned: inst?.pinned_to_sidebar === true,
      mirrored: isMirrored(inst),
      open: () => this.deps.openSub(it.id),
      latestPreview: async () => (await this.previewOf(mainId, it.id))?.slug ?? null,
      onAfterAction: () => this.deps.rerender(),
    });
  }

  private async previewOf(mainId: string, subId: string): Promise<PreviewRef | null> {
    try {
      const list = await invoke<Array<{ slug: string; title: string; session_id: string | null }>>("list_previews", { sessionId: mainId });
      // The list is newest first, so the first match is the latest.
      const hit = (Array.isArray(list) ? list : []).find((m) => m.session_id === subId);
      return hit ? { slug: hit.slug, title: hit.title } : null;
    } catch {
      return null;
    }
  }

  // ---- Clock ---------------------------------------------------------------------------

  private syncTimer(): void {
    if (this.peeks.size > 0 && this.host) {
      if (this.timer === null) {
        this.tick = 0;
        this.timer = setInterval(() => this.onTick(), 1000);
      }
    } else {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private onTick(): void {
    if (!this.host?.isConnected || this.peeks.size === 0) {
      this.stopTimer();
      return;
    }
    for (const p of this.peeks.values()) p.patch();
    this.tick += 1;
    if (this.tick % REFRESH_EVERY === 0 && !document.hidden) for (const p of this.peeks.values()) void p.load();
  }
}
