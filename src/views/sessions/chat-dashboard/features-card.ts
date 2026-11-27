// The merged Plan card's feature lines on a main chat: one line per feature with a trail of one
// kind icon per chat, and the opened feature showing one chat's plan, its latest picture and a
// message box. Owns the lines' DOM inside the Plan card's `.pf-host` like RunCard owns `.rn-host`
// (the dashboard carries the host across a redraw of the card), so a plan redraw never closes the
// opened feature or loses a half-written reply.

import { invoke } from "../../../shared/ipc";
import { showToast } from "../../../shared/toast";
import { escapeHtml } from "../../../shared/escape-html";
import { openLightbox } from "../../../shared/chat/lightbox";
import type { AnchoredPopoverHandle } from "../../../shared/chat/anchored-popover";
import { tierLabel } from "../../../shared/model-name";
import type { Composer } from "../../../shared/chat/composer";
import type { Instance, PreviewMeta } from "../../../types/ipc.generated";
import { activeChatOf, foldTrail, trailSlots, type FeatureChat, type FeatureRow, type FeaturesState } from "../../../shared/chat/dashboard/features-model";
import type { PeekImage } from "../../../shared/chat/dashboard/peek-attachments";
import { requestTodoOpen } from "../backlog-panel/backlog-open-event";
import type { SubHoverResolver } from "./sub-hover";
import { fillAgo } from "./done-card";
import { featuresHtml, type FeaturesHtmlCtx } from "./features-html";
import { openFoldPopup } from "./features-fold-popup";
import { mountSubComposer } from "./sub-composer";
import "./features-card.css";

/** The width a preview page is laid out at before it is scaled into its tile (dashboard-zones.ts). */
const PREVIEW_VIEW_W = 1280;
/** A working chat's picture list is read again after this long; a chat that stopped keeps what it has. */
const IMAGES_FRESH_MS = 20_000;
/** Image data URLs kept so a redraw does not read the bytes again. */
const URLS_KEPT = 16;

export interface FeaturesDeps {
  /** The main chat's folder, for a sub the instance list carries no folder for. */
  cwd(): string | null;
  instance(id: string): Instance | undefined;
  /** The family's previews, newest first (preview-tiles.ts). */
  previews(): readonly PreviewMeta[];
  /** The first line of a chat's task, "" until its brief was read (sub-kinds.ts). */
  task(chatId: string): string;
  /** Called after the lines' DOM was rewritten, so the preview frames in it get their page (preview-tiles.ts `mount`). */
  drawn?(): void;
}

export class FeaturesCard {
  private host: HTMLElement | null = null;
  private rows: readonly FeatureRow[] = [];
  /** Key of the opened feature. In memory only: one click to reopen after a reload. */
  private open: string | null = null;
  /** The chat Joe picked in each feature's trail; without a pick the feature shows the one that needs him or works. */
  private readonly pick = new Map<string, string>();
  private html = "";
  private comp: { id: string; root: HTMLElement; composer: Composer } | null = null;
  private readonly images = new Map<string, { at: number; list: PeekImage[] }>();
  private readonly reading = new Set<string>();
  private readonly urls = new Map<string, string>();
  private readonly readingUrl = new Set<string>();
  /** Ids whose bytes could not be read: tried once, never in a loop. */
  private readonly unreadable = new Set<string>();
  private disposed = false;
  /** Icon slots a many-chat trail has at the host's width (`trailSlots`). */
  private slots = trailSlots(0);
  private ro: ResizeObserver | null = null;
  /** The +N list that is open, redrawn against the new chip after every redraw of the lines. */
  private fold: { key: string; which: "done" | "rest"; handle: AnchoredPopoverHandle } | null = null;

  constructor(private readonly deps: FeaturesDeps) {}

  /** Draws the lines into the card's host. */
  update(host: HTMLElement, state: FeaturesState | null): void {
    if (this.host !== host) {
      // The Plan card was rebuilt around a new host: the old DOM went with it.
      this.html = "";
      this.host = host;
      // A card resized across a width bucket re-fits every trail.
      this.ro?.disconnect();
      this.ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (trailSlots(host.clientWidth) !== this.slots) this.draw(); }) : null;
      this.ro?.observe(host);
    }
    this.rows = state?.rows ?? [];
    this.draw();
    this.comp?.composer.refreshOfflineState();
  }

  /** The card has no lines any more (the chat's subs are gone, or it is no main chat). */
  detach(): void {
    this.fold?.handle.close();
    this.ro?.disconnect();
    this.ro = null;
    this.dropComposer();
    this.host = null;
    this.rows = [];
    this.html = "";
    this.open = null;
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
  }

  /** The hover card's lines for a trail icon: the sub's own state and step, as the Done card's avatars show. */
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

  private selOf = (row: FeatureRow): FeatureChat => {
    const id = this.pick.get(row.key);
    const picked = row.chats.find((c) => c.id === id);
    if (picked) return picked;
    // The chat Joe is writing to stays shown when another chat of the feature starts asking: switching
    // would drop the reply box and its text under his hands. An untouched box (no text, no focus) or a
    // finished chat never holds the card, so a chat that needs him still takes over.
    const comp = this.comp;
    const writing =
      comp && this.open === row.key && (!comp.composer.isDraftEmpty() || comp.root.contains(document.activeElement))
        ? row.chats.find((c) => c.id === comp.id && c.state !== "queued" && c.state !== "done")
        : undefined;
    return writing ?? activeChatOf(row);
  };

  private openRow(): FeatureRow | null {
    return this.open === null ? null : this.rows.find((r) => r.key === this.open) ?? null;
  }

  // ---- Drawing ------------------------------------------------------------------------------

  private draw(): void {
    const host = this.host;
    if (!host || this.disposed) return;
    if (this.open !== null && !this.openRow()) this.open = null;
    this.slots = trailSlots(host.clientWidth);
    const html = featuresHtml({ rows: [...this.rows] }, this.ctx());
    if (html !== this.html) {
      // The message box lives in the opened body; a redraw of the lines carries it over so its text and focus stay.
      const root = this.comp?.root ?? null;
      const focus = root && root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
      host.innerHTML = html;
      this.html = html;
      if (root) {
        const slot = host.querySelector<HTMLElement>(`.pf-slot[data-chat="${CSS.escape(this.comp!.id)}"]`);
        if (slot) {
          slot.appendChild(root);
          focus?.focus({ preventScroll: true });
        }
      }
      fillAgo(host);
      this.reopenFold();
      this.deps.drawn?.();
    }
    this.syncComposer();
    this.hydrateImages();
    this.loadImages();
  }

  private ctx(): FeaturesHtmlCtx {
    return {
      open: this.open,
      selOf: this.selOf,
      slots: this.slots,
      pic: (row) => this.picHtml(row),
      task: (id) => this.deps.task(id),
      slot: (id) => `<div class="pf-slot" data-chat="${escapeHtml(id)}"></div>`,
    };
  }

  /** The latest preview of the feature's chats, else their latest image, drawn like the Attachments card's rows. */
  private picHtml(row: FeatureRow): string {
    const ids = new Set(row.chats.map((c) => c.id));
    const pv = this.deps.previews().find((m) => (!!m.session_id && ids.has(m.session_id)));
    if (pv) {
      return `<button type="button" class="pf-pic" data-act="open-preview" data-slug="${escapeHtml(pv.slug)}" title="${escapeHtml(pv.title)}: open in the preview panel">`
        + `<span class="cdash-pv-tile is-thumb" data-pv-id="${escapeHtml(pv.id)}" data-pv-version="${pv.version}" style="--pv-w:${PREVIEW_VIEW_W}px"><iframe class="cdash-pv-frame" sandbox="allow-scripts" tabindex="-1" aria-hidden="true"></iframe></span>`
        + `<span class="pf-pic-t">${escapeHtml(pv.title)}</span></button>`;
    }
    const img = this.latestImage(row);
    if (!img) return "";
    return `<button type="button" class="pf-pic" data-act="pf-image" data-image="${escapeHtml(img.id)}" title="Open the picture"><span class="cdash-ithumb"><img alt="" decoding="async" data-pfimg="${escapeHtml(img.id)}"></span></button>`;
  }

  private latestImage(row: FeatureRow): { id: string } | null {
    let best: { id: string; at: number } | null = null;
    for (const c of row.chats) {
      const entry = this.images.get(c.id);
      if (!entry) continue;
      entry.list.forEach((img, i) => {
        const at = typeof img.at_ms === "number" && img.at_ms > 0 ? img.at_ms : i;
        if (!best || at >= best.at) best = { id: img.id, at };
      });
    }
    return best;
  }

  /** Reads the picture list of each chat of the opened feature that has no preview to show. */
  private loadImages(): void {
    const row = this.openRow();
    if (!row) return;
    const ids = new Set(row.chats.map((c) => c.id));
    if (this.deps.previews().some((m) => (!!m.session_id && ids.has(m.session_id)))) return;
    const now = Date.now();
    for (const c of row.chats) {
      const have = this.images.get(c.id);
      const stale = !have || (c.state === "working" && now - have.at > IMAGES_FRESH_MS);
      if (!stale || this.reading.has(c.id)) continue;
      this.reading.add(c.id);
      void invoke<{ images: PeekImage[] }>("list_session_images", { sessionId: c.id })
        .then((r) => ({ at: Date.now(), list: (r?.images ?? []).filter((i) => typeof i?.id === "string") }))
        .catch(() => ({ at: Date.now(), list: [] as PeekImage[] }))
        .then((entry) => {
          this.reading.delete(c.id);
          if (this.disposed) return;
          this.images.set(c.id, entry);
          this.draw();
        });
    }
  }

  /** Points each drawn picture at its bytes; the `img` is new after every redraw of the lines. */
  private hydrateImages(): void {
    for (const el of this.host?.querySelectorAll<HTMLImageElement>("img[data-pfimg]") ?? []) {
      const id = el.dataset.pfimg ?? "";
      if (!id || el.getAttribute("src")) continue;
      const have = this.urls.get(id);
      if (have) {
        el.src = have;
        continue;
      }
      if (this.readingUrl.has(id) || this.unreadable.has(id)) continue;
      this.readingUrl.add(id);
      void invoke<string>("dashboard_gallery_image", { id })
        .then((url) => {
          if (typeof url !== "string" || !url.startsWith("data:")) {
            this.unreadable.add(id);
            return;
          }
          if (this.urls.size >= URLS_KEPT) this.urls.delete(this.urls.keys().next().value as string);
          this.urls.set(id, url);
        })
        .catch(() => { this.unreadable.add(id); /* no bytes: the frame stays empty */ })
        .finally(() => {
          this.readingUrl.delete(id);
          if (!this.disposed) this.hydrateImages();
        });
    }
  }

  // ---- The message box ----------------------------------------------------------------------

  /** One message box, aimed at the opened feature's chat (a queued chat has nothing to answer yet). */
  private syncComposer(): void {
    const row = this.openRow();
    const sel = row ? this.selOf(row) : null;
    const want = sel && sel.state !== "queued" ? sel.id : null;
    if (this.comp && this.comp.id !== want) this.dropComposer();
    if (this.comp || !want) return;
    const slot = this.host?.querySelector<HTMLElement>(`.pf-slot[data-chat="${CSS.escape(want)}"]`);
    if (!slot) return;
    const root = document.createElement("div");
    root.className = "sx-msg pf-msg";
    slot.appendChild(root);
    const composer = mountSubComposer(root, want, {
      instance: (id) => this.deps.instance(id),
      cwd: () => this.deps.cwd(),
      name: (id) => this.chatOf(id)?.name ?? "The chat",
      offlineLabel: (id) => {
        const m = this.deps.instance(id)?.machine;
        return m && m.online === false ? m.label : null;
      },
    });
    this.comp = { id: want, root, composer };
  }

  private dropComposer(): void {
    this.comp?.composer.destroy();
    this.comp?.root.remove();
    this.comp = null;
  }

  // ---- Clicks -------------------------------------------------------------------------------

  /** Handles a click on one of the lines' `data-act`s; true when it was one of theirs. */
  act(name: string, t: HTMLElement): boolean {
    switch (name) {
      case "pf-feat": {
        const key = t.dataset.feat ?? "";
        this.open = this.open === key ? null : key;
        break;
      }
      case "pf-chat": {
        const key = t.dataset.feat ?? "";
        this.pick.set(key, t.dataset.chat ?? "");
        this.open = key;
        break;
      }
      case "pf-fold":
        this.toggleFold(t.dataset.feat ?? "", t.dataset.which === "done" ? "done" : "rest");
        return true;
      case "pf-todo":
      case "pf-ticket":
        lineLinkAct(name, t);
        return true;
      case "pf-image": {
        const m = /^data:([^;]+);base64,(.*)$/.exec(this.urls.get(t.dataset.image ?? "") ?? "");
        if (m) openLightbox({ type: "image", mime: m[1]!, base64: m[2]! });
        return true;
      }
      default:
        return false;
    }
    const hadFocus = document.activeElement === t;
    this.draw();
    if (hadFocus) this.host?.querySelector<HTMLElement>(`[data-act="${name}"][data-feat="${CSS.escape(t.dataset.feat ?? "")}"]${t.dataset.chat ? `[data-chat="${CSS.escape(t.dataset.chat)}"]` : ""}`)?.focus({ preventScroll: true });
    return true;
  }

  /** A +N: its list opens under it, a second click shuts it. */
  private toggleFold(key: string, which: "done" | "rest"): void {
    const open = this.fold;
    if (open) {
      open.handle.close();
      if (open.key === key && open.which === which) return;
    }
    this.openFold(key, which, true);
  }

  private openFold(key: string, which: "done" | "rest", focus: boolean | string): void {
    const row = this.rows.find((r) => r.key === key);
    const anchor = this.host?.querySelector<HTMLElement>(`.pf-fold[data-feat="${CSS.escape(key)}"][data-which="${which}"]`);
    if (!row || !anchor) return;
    const f = foldTrail(row.chats, this.slots);
    const chats = which === "done" ? f.done : f.rest;
    if (chats.length === 0) return;
    anchor.setAttribute("aria-expanded", "true");
    const handle = openFoldPopup({
      anchor,
      title: `${chats.length} ${which === "done" ? "finished" : "more"} ${chats.length === 1 ? "chat" : "chats"}`,
      chats,
      focus,
      pick: (id) => {
        this.pick.set(key, id);
        this.open = key;
        this.draw();
      },
      onClose: () => {
        if (this.fold?.handle === handle) this.fold = null;
        anchor.setAttribute("aria-expanded", "false");
        if (anchor.isConnected && (!document.activeElement || document.activeElement === document.body)) anchor.focus({ preventScroll: true });
      },
    });
    this.fold = { key, which, handle };
  }

  /** The lines were rewritten under an open list: it moves to the new +N, or goes when that is gone. */
  private reopenFold(): void {
    const f = this.fold;
    if (!f) return;
    const held = document.activeElement?.closest<HTMLElement>(".pf-pop-row")?.dataset.chat ?? false;
    f.handle.close();
    this.openFold(f.key, f.which, held);
  }
}

/** A line's id icons: the todo opens in the backlog, a ticket id without a link is copied. Shared with
 *  the Done card's popup, which sits outside the dashboard's click delegate. */
export function lineLinkAct(name: string, t: HTMLElement): void {
  if (name === "pf-todo") requestTodoOpen(t.dataset.todo ?? "");
  else void navigator.clipboard?.writeText(t.dataset.ticket ?? "").then(() => showToast(`Copied ${t.dataset.ticket}`), () => undefined);
}
