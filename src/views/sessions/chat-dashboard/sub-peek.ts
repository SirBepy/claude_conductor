// One sub's mini dashboard, a floating card Joe can drag and keep open beside others
// (docs/chat-dashboard-design.md, "Subchats card redesign"): run time, context chip, state, and
// two tabs: Plan (the step it is on, its last action, the brief) and Attachments (the dashboard's own
// four-tab card, for this sub: Previews, Images, Files, Links), over a real message box.
// subs-card.ts owns the set of open peeks, their position and the one-second clock; everything
// about a single sub lives here.

import { invoke } from "../../../shared/ipc";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import type { Composer } from "../../../shared/chat/composer";
import type { ChatEvent, ContextStatus, HistoryPage, Instance } from "../../../types/ipc.generated";
import { mountSubComposer } from "./sub-composer";
import { openLightbox, type LightboxContent, type LightboxGallery } from "../../../shared/chat/lightbox";
import { PREVIEW_OPEN_EVENT } from "../../../shared/chat/chat-preview-card";
import { fetchSubCards } from "../../../shared/chat/subchat-cards";
import { formatActionAge, formatRunTime, subWhy, type SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import { attachTabOf, type LinksState } from "../../../shared/chat/dashboard/dashboard-model";
import { attachTotal, peekLinksState, type PeekImage } from "../../../shared/chat/dashboard/peek-attachments";
import { contextChipHtml } from "../statusbar-chips";
import { attachTabs, initialUi } from "./dashboard-zones";
import { PreviewTiles } from "./preview-tiles";

export interface PeekDeps {
  mainId(): string;
  cwd(): string | null;
  item(id: string): SubCardItem | undefined;
  instance(id: string): Instance | undefined;
}

type PeekTab = "plan" | "attachments";

interface SubData {
  brief: string | null;
  verdict: string | null;
  /** The sub's transcript images, oldest first. */
  images: PeekImage[];
  /** The newest page of the sub's history: what the Links and Files tabs are read from. */
  events: ChatEvent[];
  ctx: ContextStatus | null;
}

/** Messages of the sub's history the Links and Files tabs read. A link or a file the sub named long ago
 *  falls off the list, as it does in the main chat's own card, which also reads only what it holds. */
const HISTORY_MESSAGES = 60;

/** Image data URLs kept for stepping back in the lightbox. */
const URL_CACHE_MAX = 16;

/** How long a closing details card shrinks (subs-card.css `sx-peek-out`; Joe picked 0.45s, 2026-11-11). */
const CLOSE_MS = 450;

export class SubPeek {
  readonly el: HTMLElement;
  private readonly data: SubData = { brief: null, verdict: null, images: [], events: [], ctx: null };
  /** Data URL per recently shown image id, so stepping back to one is not another daemon read.
   *  Capped (oldest out): a sub can hold hundreds of full-size screenshots. */
  private readonly urls = new Map<string, string>();
  private readonly reading = new Set<string>();
  /** The sub's own previews: the dashboard's tile reader, aimed at the chat this view hangs under. */
  private readonly tiles: PreviewTiles;
  /** The Attachments card's tab pick lives here, not in its HTML, so a redraw keeps it. */
  private readonly ui = initialUi();
  /** The tab Joe is on. Kept in the object, so the per-second patch and a reload never reset it. */
  private tab: PeekTab = "plan";
  private links: LinksState | null = null;
  private linksDirty = true;
  private historyRead = false;
  private composer: Composer | null = null;
  /** The offline label the composer was built under (see patch). */
  private mountedOffline: string | null = null;
  private loadSeq = 0;
  private closing = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly id: string, private readonly deps: PeekDeps) {
    this.tiles = new PreviewTiles({
      sessionId: () => this.deps.mainId(),
      schedule: () => {
        this.linksDirty = true;
        if (this.el.isConnected) this.patch();
      },
    });
    const el = document.createElement("div");
    el.className = "sx-det is-opening";
    // The grow is a one-off: the class leaves with it so a later restyle cannot replay it.
    el.addEventListener("animationend", (e) => {
      if (e.target === el) el.classList.remove("is-opening");
    });
    el.addEventListener("keydown", (e) => {
      this.tabKey(e);
      // The peek sits inside the dashboard, whose own tab-key and Space handlers must not see the
      // peek's keys; Space on a button here is the button's own press, never typed into the composer.
      const t = e.target as HTMLElement;
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && t.matches?.("[role='tab']")) e.stopPropagation();
      else if (e.key === " " && t.closest?.("button")) e.stopPropagation();
    });
    el.dataset.sub = id;
    const tabBtn = (id: PeekTab, label: string, on: boolean): string =>
      `<button type="button" class="sx-tab${on ? " on" : ""}" role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-act="peek-tab" data-tab="${id}">${label}${id === "attachments" ? `<span class="sx-tab-n" hidden></span>` : ""}</button>`;
    el.innerHTML = `<div class="sx-det-top"><span class="sx-det-name"${chatMenuAttr(id)}></span><span class="sx-det-time" title="Run time"><i class="ph ph-timer"></i><b></b></span><span class="sx-det-ctx"></span>`
      + `<button type="button" class="sx-det-x" data-act="peek-close" title="Close" aria-label="Close"><i class="ph ph-x"></i></button></div>`
      + `<div class="sx-det-state"></div>`
      + `<div class="sx-tabs" role="tablist">${tabBtn("plan", "Plan", true)}${tabBtn("attachments", "Attachments", false)}</div>`
      + `<div class="sx-pane" role="tabpanel" data-pane="plan">`
      + `<div class="sx-det-step" hidden><span></span><i class="sx-det-bar"><b></b></i></div>`
      + `<ol class="sx-det-plan" hidden></ol>`
      + `<div class="sx-det-last" hidden></div>`
      + `<details class="sx-det-brief" hidden><summary></summary><div class="sx-det-brief-full"></div></details>`
      + `</div>`
      + `<div class="sx-pane sx-att" role="tabpanel" data-pane="attachments" hidden></div>`
      + `<div class="sx-msg"></div>`;
    this.el = el;
  }

  /** Called once the element is in the document: the composer measures its surroundings on mount. */
  start(): void {
    this.mountComposer();
    void this.tiles.subscribe();
    this.tiles.ensureLoaded();
    void this.load();
    this.patch();
  }

  /** Shrinks back into the avatar it grew from, then goes. */
  close(onGone: () => void = () => {}): void {
    if (this.closing) return;
    this.closing = true;
    // With reduced motion there is nothing to shrink, so it goes at once.
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      this.destroy();
      onGone();
      return;
    }
    this.el.classList.add("is-closing");
    this.closeTimer = setTimeout(() => {
      this.destroy();
      onGone();
    }, CLOSE_MS);
  }

  destroy(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.composer?.destroy();
    this.composer = null;
    this.tiles.dispose();
    this.loadSeq += 1;
    this.el.remove();
  }

  /** True when the click was this peek's own (a button inside it). */
  handleClick(t: HTMLElement): boolean {
    const tab = t.closest<HTMLElement>("[data-act='peek-tab']");
    if (tab) {
      this.pick(tab.dataset.tab === "attachments" ? "attachments" : "plan");
      return true;
    }
    const sub = t.closest<HTMLElement>("[data-act='links-tab']");
    if (sub) {
      this.pickAttach(sub);
      return true;
    }
    const image = t.closest<HTMLElement>("[data-act='open-image']");
    if (image) {
      const id = this.data.images[Number(image.dataset.index)]?.id;
      if (id) void this.openImage(id);
      return true;
    }
    const preview = t.closest<HTMLElement>("[data-act='open-preview']");
    if (preview) {
      window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { detail: { slug: preview.dataset.slug ?? "" } }));
      return true;
    }
    return false;
  }

  /** Switches the view in place: the tab strip, the two panes and the count are patched, never rebuilt,
   *  so a keyboard user keeps their focus. The incoming pane fades in once. */
  private pick(to: PeekTab): void {
    if (this.tab === to) return;
    this.tab = to;
    this.patch();
    this.playIn(this.el.querySelector<HTMLElement>(`.sx-pane[data-pane="${to}"]`));
  }

  /** One of the Attachments card's four tabs. Its list is new HTML, so focus goes back to the tab. */
  private pickAttach(btn: HTMLElement): void {
    const tab = attachTabOf(btn.dataset.tab);
    if (!tab || this.ui.linksTab === tab) return;
    const hadFocus = document.activeElement === btn;
    this.ui.linksTab = tab;
    this.patch();
    if (hadFocus) this.el.querySelector<HTMLElement>(`.cdash-ltab[data-tab="${tab}"]`)?.focus();
    this.playIn(this.el.querySelector<HTMLElement>(".sx-att .cdash-llist"));
  }

  /** The one-shot fade of what a tab switch brings in; the class leaves at `animationend` so no later
   *  class change replays it. */
  private playIn(el: HTMLElement | null): void {
    if (!el) return;
    el.classList.remove("is-in");
    void el.offsetWidth;
    el.classList.add("is-in");
    el.addEventListener("animationend", () => el.classList.remove("is-in"), { once: true });
  }

  /** Arrow keys, Home and End move between the tabs of whichever strip has focus. */
  private tabKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const strip = t?.closest<HTMLElement>(".sx-tabs, .cdash-ltabs");
    if (!t || !strip || !t.matches("[role='tab']")) return;
    const tabs = [...strip.querySelectorAll<HTMLElement>("[role='tab']")];
    const at = tabs.indexOf(t);
    if (at < 0) return;
    const to = e.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(at - 1 + tabs.length) % tabs.length] : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : undefined;
    if (!to || to === t) return;
    e.preventDefault();
    to.focus();
    to.click();
  }

  private remember(id: string, url: string): void {
    this.urls.delete(id);
    this.urls.set(id, url);
    while (this.urls.size > URL_CACHE_MAX) this.urls.delete(this.urls.keys().next().value!);
  }

  private async openImage(id: string): Promise<void> {
    const url = this.urls.get(id) ?? await imageUrl(id);
    if (url) this.showImage(id, url);
  }

  /** Opens one image with the whole sub's list behind it, so Left and Right walk every image the sub
   *  has, including the ones the Images tab does not list ("N more in the gallery"). The list is the
   *  sub's whole `images`, never the drawn rows, and each neighbour is read only when stepped to. */
  private showImage(id: string, url: string): void {
    this.remember(id, url);
    const content = imageContent(url);
    if (!content) return;
    const ids = this.data.images.map((i) => i.id);
    const at = ids.indexOf(id);
    const group: LightboxGallery | null = at < 0 ? null : {
      count: ids.length,
      index: at,
      load: async (i) => {
        const wanted = ids[i];
        if (!wanted) return null;
        let u = this.urls.get(wanted) ?? null;
        if (!u) {
          u = await imageUrl(wanted);
          if (u) this.remember(wanted, u);
        }
        return u ? imageContent(u) : null;
      },
    };
    openLightbox(content, undefined, group);
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

    // The plan leads (it says what the sub is doing); the brief is one task line that unfolds.
    const planEl = det.querySelector<HTMLElement>(".sx-det-plan")!;
    const plan = it.hover?.plan ?? null;
    const planSig = plan ? plan.map((p) => `${p.status}:${p.text}`).join("\n") : "";
    planEl.hidden = !plan;
    if (planEl.dataset.sig !== planSig) {
      planEl.dataset.sig = planSig;
      planEl.replaceChildren(...(plan ?? []).map((p) => {
        const li = document.createElement("li");
        li.dataset.status = p.status;
        li.textContent = p.text;
        return li;
      }));
    }
    // The step line and bar say the same as the list, so the list replaces them.
    if (plan) stepEl.hidden = true;
    const brief = det.querySelector<HTMLDetailsElement>(".sx-det-brief")!;
    brief.hidden = !d.brief;
    const full = brief.querySelector<HTMLElement>(".sx-det-brief-full")!;
    if (full.textContent !== (d.brief ?? "")) {
      full.textContent = d.brief ?? "";
      const task = (d.brief ?? "").split("\n")[0]!.trim();
      brief.querySelector("summary")!.textContent = `Brief: ${task.length > 90 ? `${task.slice(0, 89)}…` : task}`;
    }

    this.patchAttachments();

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

  /** The tab strip, the panes and the Attachments card. The card's HTML is replaced only when it
   *  changed (the per-second patch lands here too), so a preview frame is never reloaded for nothing. */
  private patchAttachments(): void {
    const det = this.el;
    if (this.linksDirty || !this.links) {
      this.links = peekLinksState(this.data.events, this.data.images, this.tiles.list, this.id);
      this.linksDirty = false;
    }
    const links = this.links;
    for (const b of det.querySelectorAll<HTMLElement>(".sx-tab")) {
      const on = b.dataset.tab === this.tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const pane of det.querySelectorAll<HTMLElement>(".sx-pane")) pane.hidden = pane.dataset.pane !== this.tab;
    const n = det.querySelector<HTMLElement>(".sx-tab-n")!;
    const total = attachTotal(links);
    n.hidden = total === 0;
    if (n.textContent !== String(total)) n.textContent = String(total);
    if (this.tab !== "attachments") return;
    const att = det.querySelector<HTMLElement>(".sx-att")!;
    const html = attachTabs(links, { ui: this.ui, busy: false }, true);
    if (att.dataset.html !== html) {
      att.dataset.html = html;
      att.innerHTML = html;
    }
    this.tiles.mount(att);
    this.hydrateImages(att);
  }

  /** Points each drawn Images row at its picture. Rows are rebuilt only when the list's html changes,
   *  so a row that already holds its picture is left alone (a cache eviction must not re-read it every
   *  tick); a picture is read only when its row is on screen, never for the whole list. */
  private hydrateImages(root: HTMLElement): void {
    for (const el of root.querySelectorAll<HTMLImageElement>("img[data-gimg]")) {
      const id = this.data.images[Number(el.dataset.gimg)]?.id;
      if (!id || el.getAttribute("src")) continue;
      const have = this.urls.get(id);
      if (have) {
        el.src = have;
        continue;
      }
      if (this.reading.has(id)) continue;
      this.reading.add(id);
      void imageUrl(id).then((url) => {
        this.reading.delete(id);
        if (!url) return;
        this.remember(id, url);
        if (this.el.isConnected) this.hydrateImages(this.el);
      });
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
    jobs.push(invoke<{ images: PeekImage[] }>("list_session_images", { sessionId: id }).then((r) => {
      d.images = (r?.images ?? []).filter((i) => typeof i?.id === "string");
    }).catch(() => undefined));
    // A sub that is not working has said all it will: its history is read once, a working one's each refresh.
    if (!this.historyRead || this.deps.item(id)?.kind === "working") {
      jobs.push(this.readHistory().then((events) => {
        if (events) {
          d.events = events;
          this.historyRead = true;
        }
      }));
    }
    jobs.push(invoke<ContextStatus | null>("context_status", { sessionId: id }).then((c) => { d.ctx = c ?? null; }).catch(() => undefined));
    jobs.push(fetchSubCards(this.deps.mainId()).then((cards) => {
      const fin = cards.filter((c) => c.kind === "finish" && c.sub_id === id).pop();
      d.verdict = fin?.verdict || null;
    }));
    await Promise.all(jobs);
    this.linksDirty = true;
    if (seq === this.loadSeq && this.el.isConnected) this.patch();
  }

  /** The newest page of the sub's own transcript, or null when it could not be read. */
  private async readHistory(): Promise<ChatEvent[] | null> {
    const args: Record<string, unknown> = { sessionId: this.id, messageLimit: HISTORY_MESSAGES };
    const cwd = this.deps.instance(this.id)?.cwd ?? this.deps.cwd();
    if (cwd) args.cwd = cwd;
    try {
      const page = await invoke<HistoryPage>("load_history_page", args);
      return Array.isArray(page?.events) ? page.events : [];
    } catch {
      return null;
    }
  }

  /** The host machine's label while this sub's machine is offline, else null. */
  private offlineLabel(): string | null {
    const m = this.deps.instance(this.id)?.machine;
    return m && m.online === false ? m.label : null;
  }

  /** Mounts the chat's Composer aimed at this sub (sub-composer.ts). */
  private mountComposer(): void {
    const subId = this.id;
    this.composer = mountSubComposer(this.el.querySelector<HTMLElement>(".sx-msg")!, subId, {
      instance: (id) => this.deps.instance(id),
      cwd: () => this.deps.cwd(),
      name: (id) => this.deps.item(id)?.name ?? "The sub",
      offlineLabel: () => this.offlineLabel(),
    });
    this.mountedOffline = this.offlineLabel();
  }
}

function imageContent(url: string): LightboxContent | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  return m ? { type: "image", mime: m[1]!, base64: m[2]! } : null;
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
