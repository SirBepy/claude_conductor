// One sub's mini dashboard, a floating card Joe can drag and keep open beside others
// (docs/chat-dashboard-design.md, "Subchats card redesign"): run time, context chip, state,
// the plan step it is on, its last action, the brief, images, the latest preview and a real
// message box. subs-card.ts owns the set of open peeks, their position and the one-second clock;
// everything about a single sub lives here.

import { invoke } from "../../../shared/ipc";
import { showToast } from "../../../shared/toast";
import { Composer } from "../../../shared/chat/composer";
import { isSessionBusyError } from "../../../shared/session-busy";
import { apiCreditBlockedReason } from "../../../shared/api-credit-blocked";
import type { ContentBlock, ContextStatus, Instance } from "../../../types/ipc.generated";
import { state } from "../state";
import { openLightbox } from "../../../shared/chat/lightbox";
import { PREVIEW_OPEN_EVENT } from "../../../shared/chat/chat-preview-card";
import { fetchSubCards } from "../../../shared/chat/subchat-cards";
import { formatActionAge, formatRunTime, subWhy, type SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import { contextChipHtml } from "../statusbar-chips";

export interface PeekDeps {
  mainId(): string;
  cwd(): string | null;
  item(id: string): SubCardItem | undefined;
  instance(id: string): Instance | undefined;
}

interface PreviewRef { slug: string; title: string }

interface SubData {
  brief: string | null;
  verdict: string | null;
  imageIds: string[];
  /** Data URL of the newest image, fetched once per id. */
  thumb: { id: string; url: string } | null;
  ctx: ContextStatus | null;
  preview: PreviewRef | null;
}

/** Images the gallery loads per page. Each tile is one daemon read of a full data URL, so a sub
 *  with hundreds of screenshots must not fire them all when the gallery opens. */
export const GALLERY_PAGE = 12;

export class SubPeek {
  readonly el: HTMLElement;
  private readonly data: SubData = { brief: null, verdict: null, imageIds: [], thumb: null, ctx: null, preview: null };
  private galleryOpen = false;
  private galleryLimit = GALLERY_PAGE;
  private composer: Composer | null = null;
  /** The offline label the composer was built under (see patch). */
  private mountedOffline: string | null = null;
  private loadSeq = 0;

  constructor(readonly id: string, private readonly deps: PeekDeps) {
    const el = document.createElement("div");
    el.className = "sx-det";
    el.dataset.sub = id;
    el.innerHTML = `<div class="sx-det-top"><span class="sx-det-name"></span><span class="sx-det-time" title="Run time"><i class="ph ph-timer"></i><b></b></span><span class="sx-det-ctx"></span>`
      + `<button type="button" class="sx-det-x" data-act="peek-close" title="Close" aria-label="Close"><i class="ph ph-x"></i></button></div>`
      + `<div class="sx-det-state"></div>`
      + `<div class="sx-det-step" hidden><span></span><i class="sx-det-bar"><b></b></i></div>`
      + `<div class="sx-det-last" hidden></div>`
      + `<div class="sx-det-brief" hidden></div>`
      + `<div class="sx-det-media"><span class="sx-imgwrap" hidden><button type="button" class="sx-img" data-act="image" title="Open the image"><img alt=""></button><button type="button" class="sx-imgmore" data-act="gallery" hidden></button></span><button type="button" class="sx-pv" data-act="preview" hidden><i class="ph ph-monitor-play"></i><span></span></button></div>`
      + `<div class="sx-gallery" hidden></div>`
      + `<div class="sx-msg"></div>`;
    this.el = el;
  }

  /** Called once the element is in the document: the composer measures its surroundings on mount. */
  start(): void {
    this.mountComposer();
    void this.load();
    this.patch();
  }

  destroy(): void {
    this.composer?.destroy();
    this.composer = null;
    this.loadSeq += 1;
    this.el.remove();
  }

  /** True when the click was this peek's own (a button inside it). */
  handleClick(t: HTMLElement): boolean {
    if (t.closest("[data-act='gallery']")) {
      this.galleryOpen = !this.galleryOpen;
      this.galleryLimit = GALLERY_PAGE;
      this.patch();
      return true;
    }
    if (t.closest("[data-act='gallery-more']")) {
      this.galleryLimit += GALLERY_PAGE;
      this.patch();
      return true;
    }
    if (t.closest("[data-act='image']")) {
      if (this.data.thumb) this.showImage(this.data.thumb.url);
      return true;
    }
    const grid = t.closest<HTMLElement>("[data-act='grid-image']");
    if (grid?.dataset.url) {
      this.showImage(grid.dataset.url);
      return true;
    }
    if (t.closest("[data-act='preview']")) {
      if (this.data.preview) window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { detail: { slug: this.data.preview.slug } }));
      return true;
    }
    return false;
  }

  private showImage(url: string): void {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    if (m) openLightbox({ type: "image", mime: m[1]!, base64: m[2]! });
  }

  /** Writes the live fields in place. */
  patch(): void {
    const det = this.el;
    const it = this.deps.item(this.id);
    if (!it) return;
    const d = this.data;
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
    const stateEl = det.querySelector<HTMLElement>(".sx-det-state")!;
    stateEl.dataset.kind = it.kind;
    const stateText = it.kind === "finished" ? (d.verdict ?? (it.closing ? "closing" : "finished")) : it.progress;
    set(".sx-det-state", stateText);

    // The plan step it is on, and what it waits on. The full step list needs the sub's transcript
    // plan and is not read here (docs/chat-dashboard-design.md, "Subchats card redesign").
    const step = it.hover?.step ?? null;
    const stepEl = det.querySelector<HTMLElement>(".sx-det-step")!;
    stepEl.hidden = !step;
    if (step) {
      set(".sx-det-step span", `Step ${step.n} of ${step.total}: ${step.text}`);
      det.querySelector<HTMLElement>(".sx-det-bar b")!.style.width = `${Math.round((step.n / Math.max(1, step.total)) * 100)}%`;
    }
    const lastEl = det.querySelector<HTMLElement>(".sx-det-last")!;
    const act = it.hover?.action ?? null;
    const lastText = it.kind === "working" && act ? `${act.text}, ${formatActionAge(Date.now() - act.at)}`
      : it.kind !== "working" && it.kind !== "finished" ? subWhy(it) : "";
    lastEl.hidden = lastText === "";
    set(".sx-det-last", lastText);

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
      if (this.mountedOffline && !this.offlineLabel()) {
        this.composer.destroy();
        this.composer = null;
        this.mountComposer();
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

  private async previewOf(): Promise<PreviewRef | null> {
    try {
      const list = await invoke<Array<{ slug: string; title: string; session_id: string | null }>>("list_previews", { sessionId: this.deps.mainId() });
      // The list is newest first, so the first match is the latest.
      const hit = (Array.isArray(list) ? list : []).find((m) => m.session_id === this.id);
      return hit ? { slug: hit.slug, title: hit.title } : null;
    } catch {
      return null;
    }
  }

  /** Loads what the card shows beyond the row. Each part is best-effort: one that fails leaves
   *  its field empty rather than the card blank. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const id = this.id;
    const d = this.data;
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
    jobs.push(this.previewOf().then((p) => { d.preview = p; }));
    jobs.push(fetchSubCards(this.deps.mainId()).then((cards) => {
      const fin = cards.filter((c) => c.kind === "finish" && c.sub_id === id).pop();
      d.verdict = fin?.verdict || null;
    }));
    await Promise.all(jobs);
    if (seq === this.loadSeq && this.el.isConnected) this.patch();
  }

  /** The host machine's label while this sub's machine is offline, else null. */
  private offlineLabel(): string | null {
    const m = this.deps.instance(this.id)?.machine;
    return m && m.online === false ? m.label : null;
  }

  /** Mounts the chat's Composer aimed at this sub. `embedded` keeps it from taking the
   *  process-wide hooks (type-anywhere relay, lightbox caption, Escape, push-to-talk) from the
   *  main chat's own composer; it is not focused on mount, which on a phone would leave the
   *  keyboard without voice and swipe. */
  private mountComposer(): void {
    const subId = this.id;
    const inst = (): Instance | undefined => this.deps.instance(subId);
    const cwd = (): string => String(inst()?.cwd ?? this.deps.cwd() ?? ".");
    const composer = new Composer(this.el.querySelector<HTMLElement>(".sx-msg")!, {
      embedded: true,
      projectDir: inst()?.cwd ?? this.deps.cwd() ?? null,
      getRenderer: () => null,
      // A working sub holds the message like any busy chat; the held controller sends
      // it when the sub's turn ends, whichever chat is on screen.
      isBusy: () => inst()?.busy === true,
      isOffline: () => this.offlineLabel(),
      onStage: (blocks) => {
        const held = state.heldMessages?.stageFor(subId, blocks) ?? false;
        // The chat's own composer shows a held chip beside Send; this box has none, and the
        // text vanishing from it would read as lost.
        if (held) showToast(this.heldNotice());
        return held;
      },
      onSend: (blocks) => this.send(cwd(), blocks),
    });
    composer.setSessionId(subId, { readOnly: false });
    this.composer = composer;
    this.mountedOffline = this.offlineLabel();
  }

  private heldNotice(): string {
    return `${this.deps.item(this.id)?.name ?? "The sub"} is mid-turn. Your message goes out when it finishes.`;
  }

  /** The daemon routes a send to a sub through subchats/reply.rs's route_send,
   *  so a finished or paused one resumes the way it does from its own window.
   *  A refusal mid-turn is queued; any other failure throws so the composer puts
   *  the text and its images back. */
  private async send(cwd: string, blocks: ContentBlock[]): Promise<void> {
    const subId = this.id;
    try {
      await invoke<void>("send_message", { sessionId: subId, cwd, blocks });
    } catch (err) {
      if (isSessionBusyError(err) && state.heldMessages?.stageFor(subId, blocks)) {
        showToast(this.heldNotice());
        return;
      }
      const blocked = apiCreditBlockedReason(err);
      if (blocked === null) console.error("[subs-card] send_message failed", err);
      showToast(blocked ?? `Send failed: ${err}`);
      throw err;
    }
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
