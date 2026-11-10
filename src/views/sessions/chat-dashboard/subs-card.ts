// The Subchats card (docs/chat-dashboard-design.md, "Subchats card"): this
// chat's subs as avatars with a state ring and a model battery, and under them
// the details of the one Joe clicked. Like the Answers card it owns its DOM
// inside a fixed host, so a re-derive never wipes a typed message or an open
// gallery. The rules for who is listed live in shared/chat/dashboard/subs-model.ts.

import { invoke } from "../../../shared/ipc";
import { escapeHtml } from "../../../shared/escape-html";
import { showToast } from "../../../shared/toast";
import { openLightbox } from "../../../shared/chat/lightbox";
import { PREVIEW_OPEN_EVENT } from "../../../shared/chat/chat-preview-card";
import { fetchSubCards } from "../../../shared/chat/subchat-cards";
import {
  formatRunTime, type SubCardItem, type SubsState,
} from "../../../shared/chat/dashboard/subs-model";
import type { ContextStatus, Instance } from "../../../types/ipc.generated";
import { ringHtml, type RingSpec } from "../sidebar-ring";
import { modelBatteryHtml } from "../sidebar-row-visuals";
import { subInitials } from "../sub-list";
import { isMirrored } from "../sessions-helpers";
import { contextChipHtml } from "../statusbar-chips";
import { openSubCardMenu } from "./sub-card-menu";
import "./subs-card.css";

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

/** What the details know about the open sub beyond its row; loaded lazily. */
interface SubData {
  brief: string | null;
  verdict: string | null;
  imageIds: string[];
  /** Data URL of the newest image, fetched once per id. */
  thumb: { id: string; url: string } | null;
  ctx: ContextStatus | null;
  preview: PreviewRef | null;
}

const emptyData = (): SubData => ({ brief: null, verdict: null, imageIds: [], thumb: null, ctx: null, preview: null });

/** Seconds between data refreshes while a sub's details are open (the clock ticks every second). */
const REFRESH_EVERY = 5;

export function avatarHtml(it: SubCardItem, ring: string, selected: boolean): string {
  const name = escapeHtml(it.name);
  return `<button type="button" class="sx-av${selected ? " on" : ""}" data-sub="${escapeHtml(it.id)}" data-kind="${it.kind}" aria-pressed="${selected}" title="${name}: ${escapeHtml(it.progress)}" aria-label="${name}, ${escapeHtml(it.progress)}">`
    + `<span class="sx-face">${escapeHtml(subInitials(it.name))}${ring}</span>${modelBatteryHtml(it.model, it.effort)}</button>`;
}

export class SubsCard {
  private host: HTMLElement | null = null;
  private state: SubsState | null = null;
  private selected: string | null = null;
  private earlierOpen = false;
  private galleryOpen = false;
  private readonly data = new Map<string, SubData>();
  private rowSig = "";
  private detFor: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private loadSeq = 0;

  constructor(private readonly deps: SubsCardDeps) {}

  /** Draws `state` into `host` (the zone's fixed element). A new host (the zone
   *  was drawn again after being empty) starts the card over. */
  update(host: HTMLElement, state: SubsState | null): void {
    if (this.host !== host) {
      this.host = host;
      this.rowSig = "";
      this.detFor = null;
      host.innerHTML = `<div class="sx-row"></div><div class="sx-earlier-row" hidden></div><div class="sx-det" hidden></div>`;
      host.addEventListener("click", (e) => this.onClick(e));
      host.addEventListener("contextmenu", (e) => this.onContext(e));
      host.addEventListener("submit", (e) => this.onSubmit(e));
    }
    this.state = state;
    const all = state ? [...state.shown, ...state.earlier] : [];
    if (this.selected && !all.some((i) => i.id === this.selected)) this.close();
    this.renderRow();
    this.renderDetails();
    this.syncTimer();
  }

  /** The zone is gone (the card has nothing to show). */
  detach(): void {
    this.host = null;
    this.state = null;
    this.stopTimer();
  }

  dispose(): void {
    this.detach();
    this.data.clear();
  }

  /** Test seam: the open sub's id. */
  get openId(): string | null {
    return this.selected;
  }

  private item(id: string): SubCardItem | undefined {
    return [...(this.state?.shown ?? []), ...(this.state?.earlier ?? [])].find((i) => i.id === id);
  }

  private instance(id: string): Instance | undefined {
    return this.deps.sessions().find((s) => s.session_id === id);
  }

  // ---- Row of avatars ------------------------------------------------------------

  private renderRow(): void {
    const host = this.host;
    if (!host || !this.state) return;
    const { shown, earlier } = this.state;
    // The ring's markup carries an animation phase that changes on every build,
    // so the row is only rebuilt when what it draws changed.
    const sig = JSON.stringify([
      shown.map((i) => [i.id, i.kind, i.closing, i.model, i.effort, i.progress, i.ring]),
      earlier.map((i) => [i.id, i.kind, i.ring]),
      this.selected, this.earlierOpen,
    ]);
    if (sig === this.rowSig) return;
    this.rowSig = sig;
    const av = (i: SubCardItem): string => avatarHtml(i, ringHtml(i.ring as RingSpec), i.id === this.selected);
    const more = earlier.length > 0
      ? `<button type="button" class="sx-earlier${this.earlierOpen ? " on" : ""}" data-act="earlier" aria-expanded="${this.earlierOpen}">+${earlier.length} earlier</button>` : "";
    host.querySelector<HTMLElement>(".sx-row")!.innerHTML = shown.map(av).join("") + more;
    const list = host.querySelector<HTMLElement>(".sx-earlier-row")!;
    list.hidden = !(this.earlierOpen && earlier.length > 0);
    list.innerHTML = this.earlierOpen ? earlier.map(av).join("") : "";
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]");
    if (act?.dataset.act === "earlier") {
      this.earlierOpen = !this.earlierOpen;
      this.rowSig = "";
      this.renderRow();
      return;
    }
    const av = t.closest<HTMLElement>(".sx-av");
    if (av?.dataset.sub) {
      this.toggle(av.dataset.sub);
      return;
    }
    if (t.closest("[data-act='gallery']")) {
      this.galleryOpen = !this.galleryOpen;
      this.patchDetails();
      return;
    }
    const thumb = t.closest<HTMLElement>("[data-act='image']");
    if (thumb) {
      const d = this.selected ? this.data.get(this.selected) : undefined;
      if (d?.thumb) this.showImage(d.thumb.url);
      return;
    }
    const grid = t.closest<HTMLElement>("[data-act='grid-image']");
    if (grid?.dataset.url) {
      this.showImage(grid.dataset.url);
      return;
    }
    if (t.closest("[data-act='preview']")) {
      const d = this.selected ? this.data.get(this.selected) : undefined;
      if (d?.preview) window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { detail: { slug: d.preview.slug } }));
    }
  }

  private toggle(id: string): void {
    if (this.selected === id) this.close();
    else {
      this.selected = id;
      this.galleryOpen = false;
    }
    this.rowSig = "";
    this.renderRow();
    this.renderDetails();
    this.syncTimer();
  }

  private close(): void {
    this.selected = null;
    this.galleryOpen = false;
    this.detFor = null;
  }

  private showImage(url: string): void {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    if (m) openLightbox({ type: "image", mime: m[1]!, base64: m[2]! });
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

  // ---- Details ---------------------------------------------------------------------

  private renderDetails(): void {
    const det = this.host?.querySelector<HTMLElement>(".sx-det");
    if (!det) return;
    const it = this.selected ? this.item(this.selected) : undefined;
    if (!it) {
      det.hidden = true;
      det.innerHTML = "";
      this.detFor = null;
      return;
    }
    det.hidden = false;
    if (this.detFor !== it.id) {
      this.detFor = it.id;
      det.dataset.sub = it.id;
      det.innerHTML = `<div class="sx-det-top"><span class="sx-det-name"></span><span class="sx-det-time" title="Run time"><i class="ph ph-timer"></i><b></b></span><span class="sx-det-ctx"></span></div>`
        + `<div class="sx-det-state"></div><div class="sx-det-brief" hidden></div>`
        + `<div class="sx-det-media"><span class="sx-imgwrap" hidden><button type="button" class="sx-img" data-act="image" title="Open the image"><img alt=""></button><button type="button" class="sx-imgmore" data-act="gallery" hidden></button></span><button type="button" class="sx-pv" data-act="preview" hidden><i class="ph ph-monitor-play"></i><span></span></button></div>`
        + `<div class="sx-gallery" hidden></div>`
        + `<form class="sx-msg"><input type="text" class="sx-msg-in" autocomplete="off"><button type="submit" class="sx-msg-send" title="Send" aria-label="Send"><i class="ph ph-paper-plane-tilt"></i></button></form>`;
      det.querySelector<HTMLInputElement>(".sx-msg-in")!.placeholder = `Message ${it.name}`;
      void this.load(it.id);
    }
    this.patchDetails();
  }

  /** Writes the live fields of the open sub's details in place. */
  private patchDetails(): void {
    const det = this.host?.querySelector<HTMLElement>(".sx-det");
    const it = this.selected ? this.item(this.selected) : undefined;
    if (!det || !it) return;
    const d = this.data.get(it.id) ?? emptyData();
    const set = (sel: string, text: string): void => {
      const el = det.querySelector<HTMLElement>(sel);
      if (el && el.textContent !== text) el.textContent = text;
    };
    set(".sx-det-name", it.name);
    const start = Date.parse(it.startedAt ?? "");
    const end = it.kind === "finished" && it.finishedAt !== null ? it.finishedAt : Date.now();
    set(".sx-det-time b", Number.isNaN(start) ? "--:--" : formatRunTime(end - start));
    const ctx = det.querySelector<HTMLElement>(".sx-det-ctx")!;
    const ctxHtml = d.ctx ? contextChipHtml(d.ctx, false) : "";
    if (ctx.dataset.html !== ctxHtml) {
      ctx.dataset.html = ctxHtml;
      ctx.innerHTML = ctxHtml;
    }
    const state = det.querySelector<HTMLElement>(".sx-det-state")!;
    state.dataset.kind = it.kind;
    const stateText = it.kind === "finished" ? (d.verdict ?? (it.closing ? "closing" : "finished")) : it.progress;
    set(".sx-det-state", stateText);
    const brief = det.querySelector<HTMLElement>(".sx-det-brief")!;
    brief.hidden = !d.brief;
    if (brief.textContent !== (d.brief ?? "")) brief.textContent = d.brief ?? "";

    const wrap = det.querySelector<HTMLElement>(".sx-imgwrap")!;
    wrap.hidden = d.imageIds.length === 0;
    const img = det.querySelector<HTMLImageElement>(".sx-img img")!;
    if (d.thumb && img.getAttribute("src") !== d.thumb.url) img.src = d.thumb.url;
    const more = det.querySelector<HTMLElement>(".sx-imgmore")!;
    more.hidden = d.imageIds.length < 2;
    more.textContent = `+${d.imageIds.length - 1}`;
    more.title = `Show all ${d.imageIds.length} images`;
    more.classList.toggle("on", this.galleryOpen);
    const pv = det.querySelector<HTMLElement>(".sx-pv")!;
    pv.hidden = !d.preview;
    set(".sx-pv span", d.preview?.title ?? "");
    const gal = det.querySelector<HTMLElement>(".sx-gallery")!;
    gal.hidden = !this.galleryOpen || d.imageIds.length < 2;
    if (!gal.hidden && gal.dataset.for !== d.imageIds.join(",")) {
      gal.dataset.for = d.imageIds.join(",");
      gal.innerHTML = "";
      for (const id of d.imageIds) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sx-gal-img";
        b.dataset.act = "grid-image";
        void imageUrl(id).then((url) => {
          if (!url) return;
          b.dataset.url = url;
          b.innerHTML = `<img alt="" src="${url}">`;
        });
        gal.appendChild(b);
      }
    }
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

  /** Loads what the details show beyond the row. Each part is best-effort: one
   *  that fails leaves its field empty rather than the details blank. */
  private async load(id: string): Promise<void> {
    const seq = ++this.loadSeq;
    const mainId = this.deps.mainId();
    const d = this.data.get(id) ?? emptyData();
    this.data.set(id, d);
    const jobs: Promise<void>[] = [];
    if (d.brief === null) {
      jobs.push(invoke<{ brief: { task?: string; goal?: string; done_when?: string } | null }>("get_sub_brief", { sessionId: id }).then((r) => {
        const b = r?.brief;
        d.brief = b ? [b.task, b.goal, b.done_when ? `Done when: ${b.done_when}` : ""].filter((x) => !!x && x.trim() !== "").join("\n") : "";
      }).catch(() => { d.brief = ""; }));
    }
    jobs.push(invoke<{ images: Array<{ id: string }> }>("list_session_images", { sessionId: id }).then(async (r) => {
      d.imageIds = (r?.images ?? []).map((i) => i.id);
      const newest = d.imageIds[d.imageIds.length - 1];
      if (newest && d.thumb?.id !== newest) {
        const url = await imageUrl(newest);
        if (url) d.thumb = { id: newest, url };
      }
      if (!newest) d.thumb = null;
    }).catch(() => undefined));
    jobs.push(invoke<ContextStatus | null>("context_status", { sessionId: id }).then((c) => { d.ctx = c ?? null; }).catch(() => undefined));
    jobs.push(this.previewOf(mainId, id).then((p) => { d.preview = p; }));
    jobs.push(fetchSubCards(mainId).then((cards) => {
      const fin = cards.filter((c) => c.kind === "finish" && c.sub_id === id).pop();
      d.verdict = fin?.verdict || null;
    }));
    await Promise.all(jobs);
    if (seq === this.loadSeq && this.selected === id) this.patchDetails();
  }

  private onSubmit(e: Event): void {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>("form.sx-msg");
    if (!form || !this.selected) return;
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>(".sx-msg-in")!;
    const text = input.value.trim();
    if (!text) return;
    const id = this.selected;
    input.value = "";
    // The daemon routes a send to a sub through subchats/reply.rs's route_send,
    // so a finished or paused one resumes the way it does from its own window.
    invoke("send_message", { sessionId: id, cwd: this.deps.cwd() ?? ".", blocks: [{ type: "text", text }] })
      .catch((err) => {
        input.value = text;
        showToast(`Send failed: ${err}`);
      });
  }

  // ---- Clock ---------------------------------------------------------------------------

  private syncTimer(): void {
    if (this.selected && this.host) {
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
    if (!this.host?.isConnected || !this.selected) {
      this.stopTimer();
      return;
    }
    this.patchDetails();
    this.tick += 1;
    if (this.tick % REFRESH_EVERY === 0 && !document.hidden) void this.load(this.selected);
  }
}

/** A transcript image as a data URL, via the dashboard gallery's own reader. */
async function imageUrl(id: string): Promise<string | null> {
  try {
    const url = await invoke<string>("dashboard_gallery_image", { id });
    return typeof url === "string" && url.startsWith("data:") ? url : null;
  } catch {
    return null;
  }
}
