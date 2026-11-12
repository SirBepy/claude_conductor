// The Subchats card (docs/chat-dashboard-design.md, "Subchats card"): this
// chat's subs as avatars with a state ring and a model battery, and under them
// the details of the one Joe clicked. Like the Answers card it owns its DOM
// inside a fixed host, so a re-derive never wipes a typed message or an open
// gallery. The rules for who is listed live in shared/chat/dashboard/subs-model.ts.

import { invoke } from "../../../shared/ipc";
import { escapeHtml } from "../../../shared/escape-html";
import { showToast } from "../../../shared/toast";
import { Composer } from "../../../shared/chat/composer";
import { isSessionBusyError } from "../../../shared/session-busy";
import { apiCreditBlockedReason } from "../../../shared/api-credit-blocked";
import type { ContentBlock } from "../../../types/ipc.generated";
import { state } from "../state";
import { openLightbox } from "../../../shared/chat/lightbox";
import { PREVIEW_OPEN_EVENT } from "../../../shared/chat/chat-preview-card";
import { fetchSubCards } from "../../../shared/chat/subchat-cards";
import {
  formatRunTime, type SubCardItem, type SubsState,
} from "../../../shared/chat/dashboard/subs-model";
import type { ContextStatus, Instance } from "../../../types/ipc.generated";
import { ringHtml, type RingSpec } from "../sidebar-ring";
import type { SubHoverInput } from "../sidebar-hover-card-html";
import { modelBatteryHtml } from "../sidebar-row-visuals";
import { subGlyphHtml, subInitials } from "../sub-list";
import { tierLabel } from "../../../shared/model-name";
import { attachSubHover } from "./sub-hover";
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

/** Images the details gallery loads per page. Each tile is one daemon read of a full data URL, so a sub
 *  with hundreds of screenshots must not fire them all when the gallery opens. */
export const GALLERY_PAGE = 12;

/** No native `title`: the hover card (sub-hover.ts) says it, and two tooltips on one avatar would stack. */
export function avatarHtml(it: SubCardItem, ring: string, selected: boolean): string {
  const name = escapeHtml(it.name);
  return `<button type="button" class="sx-av${selected ? " on" : ""}" data-sub="${escapeHtml(it.id)}" data-kind="${it.kind}" aria-pressed="${selected}" aria-label="${name}, ${escapeHtml(it.progress)}">`
    + `<span class="sx-face">${escapeHtml(subInitials(it.name))}${ring}</span>${subGlyphHtml(it.kind)}${modelBatteryHtml(it.model, it.effort)}</button>`;
}

export class SubsCard {
  private host: HTMLElement | null = null;
  private state: SubsState | null = null;
  private selected: string | null = null;
  private earlierOpen = false;
  private galleryOpen = false;
  /** How many gallery tiles the open sub may show; grows by one page per "more". */
  private galleryLimit = GALLERY_PAGE;
  private readonly data = new Map<string, SubData>();
  private rowSig = "";
  private detFor: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private loadSeq = 0;
  /** The message box under the open sub's details: the chat's own Composer, so a
   *  sub is typed to the same way as any chat (skills popup, image paste, send
   *  button, keyboard rules). One at a time, torn down with the details. */
  private composer: Composer | null = null;
  /** The offline label the composer was built under (see patchDetails). */
  private mountedOffline: string | null = null;

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
      attachSubHover(host, (id) => this.hoverInput(id));
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
    this.unmountComposer();
    this.host = null;
    this.state = null;
    this.stopTimer();
  }

  dispose(): void {
    this.detach();
    this.data.clear();
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
      this.galleryLimit = GALLERY_PAGE;
      this.patchDetails();
      return;
    }
    if (t.closest("[data-act='gallery-more']")) {
      this.galleryLimit += GALLERY_PAGE;
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
      this.galleryLimit = GALLERY_PAGE;
    }
    this.rowSig = "";
    this.renderRow();
    this.renderDetails();
    this.syncTimer();
  }

  private close(): void {
    this.selected = null;
    this.galleryOpen = false;
    this.galleryLimit = GALLERY_PAGE;
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
      this.unmountComposer();
      det.hidden = true;
      det.innerHTML = "";
      this.detFor = null;
      return;
    }
    det.hidden = false;
    if (this.detFor !== it.id) {
      this.unmountComposer();
      this.detFor = it.id;
      det.dataset.sub = it.id;
      det.innerHTML = `<div class="sx-det-top"><span class="sx-det-name"></span><span class="sx-det-time" title="Run time"><i class="ph ph-timer"></i><b></b></span><span class="sx-det-ctx"></span></div>`
        + `<div class="sx-det-state"></div><div class="sx-det-brief" hidden></div>`
        + `<div class="sx-det-media"><span class="sx-imgwrap" hidden><button type="button" class="sx-img" data-act="image" title="Open the image"><img alt=""></button><button type="button" class="sx-imgmore" data-act="gallery" hidden></button></span><button type="button" class="sx-pv" data-act="preview" hidden><i class="ph ph-monitor-play"></i><span></span></button></div>`
        + `<div class="sx-gallery" hidden></div>`
        + `<div class="sx-msg"></div>`;
      this.mountComposer(det.querySelector<HTMLElement>(".sx-msg")!, it.id);
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
    if (!gal.hidden) this.renderGallery(gal, d.imageIds);
    // A paired machine going offline or coming back while the box is open. Going offline only
    // disables the box in place (a draft in progress survives). A box built while offline never
    // wired Enter, Send or paste, so coming back is a rebuild (the draft is stored per sub).
    if (this.composer) {
      if (this.mountedOffline && !this.offlineLabel(it.id)) {
        this.unmountComposer();
        this.mountComposer(det.querySelector<HTMLElement>(".sx-msg")!, it.id);
      } else {
        this.composer.refreshOfflineState();
      }
    }
  }

  /** Fills the gallery up to `galleryLimit` tiles. A tile is added once and never rebuilt, so the
   *  per-second patch costs nothing and an open page keeps its already-loaded images. */
  private renderGallery(gal: HTMLElement, ids: readonly string[]): void {
    if (gal.dataset.for !== ids.join(",")) {
      gal.dataset.for = ids.join(",");
      gal.innerHTML = "";
    }
    const tiles = gal.querySelectorAll(".sx-gal-img").length;
    // Tiles are never removed, so after a close and reopen the limit is back at one page while the
    // earlier pages are still drawn: catch the limit up, or "more" would add nothing until it passes them.
    if (tiles > this.galleryLimit) this.galleryLimit = tiles;
    for (const id of ids.slice(tiles, this.galleryLimit)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sx-gal-img";
      b.dataset.act = "grid-image";
      const img = document.createElement("img");
      img.alt = "";
      b.appendChild(img);
      void imageUrl(id).then((url) => {
        if (!url) return;
        b.dataset.url = url;
        img.src = url;
      });
      gal.appendChild(b);
    }
    const rest = ids.length - Math.min(ids.length, this.galleryLimit);
    let more = gal.querySelector<HTMLButtonElement>(".sx-gal-more");
    if (rest <= 0) { more?.remove(); return; }
    if (!more) {
      more = document.createElement("button");
      more.type = "button";
      more.className = "sx-gal-more";
      more.dataset.act = "gallery-more";
    }
    const label = `Show ${Math.min(rest, GALLERY_PAGE)} more (${rest} left)`;
    if (more.textContent !== label) more.textContent = label;
    // The per-second patch lands here too; re-appending the last child would drop a click in progress.
    if (gal.lastElementChild !== more) gal.appendChild(more);
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

  /** The host machine's label while this sub's machine is offline, else null. */
  private offlineLabel(subId: string): string | null {
    const m = this.instance(subId)?.machine;
    return m && m.online === false ? m.label : null;
  }

  private unmountComposer(): void {
    this.composer?.destroy();
    this.composer = null;
  }

  /** Mounts the chat's Composer on `root` aimed at `subId`. `embedded` keeps it from
   *  taking the process-wide hooks (type-anywhere relay, lightbox caption, Escape,
   *  push-to-talk) from the main chat's own composer; it is not focused on mount,
   *  which on a phone would leave the keyboard without voice and swipe. */
  private mountComposer(root: HTMLElement, subId: string): void {
    const inst = (): Instance | undefined => this.instance(subId);
    const cwd = (): string => String(inst()?.cwd ?? this.deps.cwd() ?? ".");
    const composer = new Composer(root, {
      embedded: true,
      projectDir: inst()?.cwd ?? this.deps.cwd() ?? null,
      getRenderer: () => null,
      // A working sub holds the message like any busy chat; the held controller sends
      // it when the sub's turn ends, whichever chat is on screen.
      isBusy: () => inst()?.busy === true,
      isOffline: () => this.offlineLabel(subId),
      onStage: (blocks) => {
        const held = state.heldMessages?.stageFor(subId, blocks) ?? false;
        // The chat's own composer shows a held chip beside Send; this box has none, and the
        // text vanishing from it would read as lost.
        if (held) showToast(this.heldNotice(subId));
        return held;
      },
      onSend: (blocks) => this.send(subId, cwd(), blocks),
    });
    composer.setSessionId(subId, { readOnly: false });
    this.composer = composer;
    this.mountedOffline = this.offlineLabel(subId);
  }

  private heldNotice(subId: string): string {
    return `${this.item(subId)?.name ?? "The sub"} is mid-turn. Your message goes out when it finishes.`;
  }

  /** The daemon routes a send to a sub through subchats/reply.rs's route_send,
   *  so a finished or paused one resumes the way it does from its own window.
   *  A refusal mid-turn is queued; any other failure throws so the composer puts
   *  the text and its images back. */
  private async send(subId: string, cwd: string, blocks: ContentBlock[]): Promise<void> {
    try {
      await invoke<void>("send_message", { sessionId: subId, cwd, blocks });
    } catch (err) {
      if (isSessionBusyError(err) && state.heldMessages?.stageFor(subId, blocks)) {
        showToast(this.heldNotice(subId));
        return;
      }
      const blocked = apiCreditBlockedReason(err);
      if (blocked === null) console.error("[subs-card] send_message failed", err);
      showToast(blocked ?? `Send failed: ${err}`);
      throw err;
    }
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
