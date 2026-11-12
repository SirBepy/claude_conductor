// The chat dashboard for one chat window (docs/chat-dashboard-design.md):
// mounted beside the transcript, never inside it. The ChatRenderer keeps
// building its transcript exactly as in Messages view (hidden by CSS while the
// dashboard shows), so switching views is instant and nothing that reads the
// transcript (pagination, the image gallery, Code mode, the statusbar) changes.
// After every flush the renderer fires onFlushed; this re-derives the zones
// (dashboard-model.ts) and redraws only the zones whose HTML changed.

import type { ChatRenderer } from "../../../shared/chat/chat-renderer";
import { deriveDashboard, sectionOn, type DashboardState, type ZoneId } from "../../../shared/chat/dashboard/dashboard-model";
import { handleAttachmentClick, handleCopyClick, handlePastedLogClick, handleSlashClick, handleTableFullscreen } from "../../../shared/chat/chat-click-handlers";
import { createHandleBlockImageClick } from "../../../shared/chat/chat-renderer-click-handlers";
import { handleCommitRefClick, handleCommitRefKeydown, resolveCommitRefs } from "../../../shared/chat/commit-refs";
import { linkifyTickets } from "../../../shared/chat/ticket-refs";
import { hydrateAttachments } from "../../../shared/chat/attachment-hydrator";
import { clampUserMessages } from "../../../shared/chat/turn-collapse";
import { state } from "../state";
import { handleDrillAnchorClick, handleDrillClick, linkifyDrillRefs } from "../../../shared/chat/drill-links";
import { handleFileRefClick, handleFileRefContextMenu, handleFileRefKeydown, linkifyFilePaths, openFileRef } from "../../../shared/chat/file-refs";
import { highlightCodeBlocks, highlightInlineCode } from "../../../shared/chat/code-highlighter";
import { scrollToBottom } from "../../../shared/chat/chat-dom-renderer";
import { initialUi, renderStrip, renderZone, QUICK_VIEWS, type DashUi, type QuickViewId } from "./dashboard-zones";
import { filterPlanList, syncPlanListFade } from "./plan-card";
import type { PlanState } from "../../../shared/chat/dashboard/dashboard-model";
import { AnswersCard } from "./answers-card";
import { sendRevision } from "../drafts-revise";
import { QUESTION_ASK_EVENT, type QuestionAsk } from "../question-ask";
import { HOST_ID } from "../permission-modal/host";
import { SubsCard } from "./subs-card";
import { collectSubItems } from "./subs-source";
import { fetchSubCards } from "../../../shared/chat/subchat-cards";
import type { SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import { CHAT_VIEW_CHANGED, dashboardEnabled, readSections } from "./chat-view-pref";
import { fetchQuickView, openQuickView } from "./quick-view";
import { invoke } from "../../../shared/ipc";
import { getSettings } from "../../../shared/state";
import { getTransport } from "../../../shared/transport";
import { PREVIEW_OPEN_EVENT } from "../../../shared/chat/chat-preview-card";
import { buildPreviewDocumentHtml } from "../preview-panel-document";
import { ownerTag, scopeRoot } from "../shared-mockup-scope";
import type { MessageDraft, PreviewMeta, PreviewSnapshot } from "../../../types/ipc.generated";
import { draftIdsOf, type DraftItem, type DraftStoreSide } from "../../../shared/chat/dashboard/drafts-model";
import { DRAFT_OPEN_EVENT, copyDraft } from "../../../shared/chat/chat-draft-card";
import { ACTIVE_QUESTION_EVENT, activeCardFor, expandActiveCard } from "../permission-modal/question-state";
import "./chat-dashboard.css";
import "./dashboard-extras.css";

/** Set on the pane while the dashboard shows; the CSS hides the transcript off it. */
export const DASH_ATTR = "data-chat-view";

export class ChatDashboard {
  /** How long after a failed drafts store read the next one may run. A static
   *  so a test can shorten it. */
  static draftRetryMs = 5000;
  readonly el: HTMLElement;
  private readonly stripEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly leftEl: HTMLElement;
  private readonly rightEl: HTMLElement;
  private readonly zoneEls = new Map<ZoneId, { el: HTMLElement; html: string }>();
  private stripHtml = "";
  private ui: DashUi = initialUi();
  /** The Plan zone's last derive: the pager steps through its jobs. */
  private plan: PlanState | null = null;
  /** When this view saw the last turn end: live rows can carry no stamp, so
   *  the idle footer's "since" comes from here when it is later. */
  private idleAt: number | null = null;
  private wasBusy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private barObserver: MutationObserver | null = null;
  /** The chat's status line, and where it lives when the Plan card is not drawn. */
  private readonly bar: HTMLElement | null;
  private readonly barHome: HTMLElement | null;
  private disposed = false;
  /** The Answers card keeps its own DOM inside the zone's host (answers-card.ts). */
  private readonly answers: AnswersCard;
  /** So does the Subchats card (subs-card.ts). */
  private readonly subs: SubsCard;
  /** When each sub last finished, from the main chat's finish cards. */
  private finishedAt: ReadonlyMap<string, number> = new Map();
  private finishedSig = "";
  private foldTimer: ReturnType<typeof setTimeout> | null = null;
  /** The family's previews, newest first (list_previews scoped to the main
   *  chat); the Preview card keeps this chat's own and folds the rest. */
  private previews: PreviewMeta[] = [];
  /** The list is read once the renderer knows its chat: attach() sets the id
   *  after this dashboard is built. */
  private previewsAsked = false;
  private unlistenPreview: (() => void) | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Staged tile documents by `id@version`: a redraw of the card reuses the
   *  address instead of fetching and staging the page again. */
  private readonly tileSrc = new Map<string, string>();
  private readonly tileLoading = new Set<string>();
  /** Which quick views have something to read (see ensureQuick). */
  private quick: Partial<Record<QuickViewId, boolean>> = {};
  private quickAsked = false;
  /** The drafts store as last read, for the Drafts card (drafts-model.ts). */
  private draftStore: DraftStoreSide | undefined;
  /** The draft ids the chat's rows named at the last read: a new one reads again.
   *  Null until the first read, which runs even with no draft row in view, since
   *  the chat's drafts can sit on an older history page. */
  private draftSig: string | null = null;
  /** After a failed read, when to try again (a read is cheap, a loop is not). */
  private draftRetryAt = 0;
  /** Reads failed in a row. A chat the daemon does not know (a paired
   *  machine's mirrored one) fails every time, so retries stop after a few. */
  private draftFails = 0;
  /** Numbers each store read, so an older read that answers late never
   *  replaces a newer one. */
  private draftReq = 0;
  private unlistenDrafts: (() => void) | null = null;
  private draftsTimer: ReturnType<typeof setTimeout> | null = null;
  /** The Drafts card's items as last drawn, by key, for Copy. */
  private draftItems = new Map<string, DraftItem>();
  /** Files the Links and files card lists: a plan doc the chat names can stand in for PLAN.md. */
  private linkedFiles: string[] = [];
  private readonly onFlushed = (): void => this.schedule();
  private readonly onDocClick = (e: MouseEvent): void => {
    if (!this.ui.earlierOpen || this.stripEl.contains(e.target as Node)) return;
    this.ui.earlierOpen = false;
    this.render();
  };
  /** A question card's Ask (question-ask.ts). The card sits in this pane's
   *  composer, so the dashboard of the pane holding it takes the ask. */
  private readonly onQuestionAsk = (e: Event): void => {
    const card = document.getElementById(HOST_ID);
    if (this.disposed || e.defaultPrevented || !this.el.isConnected || !card || !this.pane.contains(card)) return;
    e.preventDefault();
    this.answers.askAbout((e as CustomEvent<QuestionAsk>).detail);
    this.schedule();
  };
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.ui.earlierOpen) {
      this.ui.earlierOpen = false;
      this.render();
    } else if (e.key === "Escape" && this.ui.planList && this.ownsFocus()) {
      // Only Esc meant for the dashboard: not one pressed in the composer or a
      // modal. A window holds one dashboard (attachChatDashboard disposes the
      // last), so no hidden chat's list closes with it.
      this.act("plan-list", this.el);
    }
  };

  constructor(readonly pane: HTMLElement, readonly renderer: ChatRenderer) {
    this.el = document.createElement("div");
    this.el.className = "cdash";
    this.el.innerHTML = `<div class="cdash-strip" hidden></div><div class="cdash-body"><div class="cdash-grid"><div class="cdash-col cdash-left"></div><div class="cdash-col cdash-right"></div></div></div>`;
    this.stripEl = this.el.querySelector(".cdash-strip")!;
    this.bodyEl = this.el.querySelector(".cdash-body")!;
    this.leftEl = this.el.querySelector(".cdash-left")!;
    this.rightEl = this.el.querySelector(".cdash-right")!;
    this.bar = pane.querySelector<HTMLElement>(".session-thinking");
    this.answers = new AnswersCard({
      sessionId: () => renderer.sessionId,
      cwd: () => renderer.paginator.cwdHint ?? null,
      onSideChange: () => this.schedule(),
      decorate: (root) => this.decorate(root),
      expandQuestion: () => {
        const sid = renderer.sessionId;
        if (sid) expandActiveCard({ sessionId: sid });
      },
      subAlive: (subId) => state.sessions.some((s) => s.session_id === subId),
      handOff: async (subId, build) => {
        const own = renderer.sessionId;
        if (!own) return false;
        // A sub's answer goes back to that sub while its row exists; a gone sub's to this chat.
        const toSub = !!subId && state.sessions.some((s) => s.session_id === subId);
        // sendRevision is the shared "send as Joe's message to that chat, else this
        // one" path (busy chat: held, failed: marked and toasted), not draft-specific.
        return sendRevision(toSub ? subId! : own, own, build(toSub));
      },
    });
    this.subs = new SubsCard({
      mainId: () => renderer.sessionId ?? "",
      cwd: () => renderer.paginator.cwdHint ?? null,
      sessions: () => state.sessions,
      openSub: async (subId) => {
        const { subchatNavFor } = await import("../active-session");
        await subchatNavFor(pane).open(subId);
      },
      rerender: () => this.schedule(),
    });
    this.barHome = this.bar?.parentElement ?? null;

    // The cards are the transcript's own, so they get the transcript's own
    // click handlers for what they carry: copy buttons, detail links, file refs,
    // tables, commit refs, and the chips in Joe's own message.
    this.el.addEventListener("click", handleCopyClick);
    this.el.addEventListener("click", handleAttachmentClick);
    this.el.addEventListener("click", handlePastedLogClick);
    this.el.addEventListener("click", handleSlashClick);
    this.el.addEventListener("click", handleCommitRefClick);
    this.el.addEventListener("keydown", handleCommitRefKeydown);
    this.el.addEventListener("click", handleDrillClick);
    this.el.addEventListener("click", handleDrillAnchorClick);
    this.el.addEventListener("click", handleFileRefClick);
    this.el.addEventListener("contextmenu", handleFileRefContextMenu);
    this.el.addEventListener("keydown", handleFileRefKeydown);
    this.el.addEventListener("click", handleTableFullscreen);
    // An image in a card opens the chat-wide gallery, like one in the transcript.
    this.el.addEventListener("click", createHandleBlockImageClick(renderer));
    this.el.addEventListener("click", (e) => this.onClick(e));
    // On an earlier plan the Plan card's foot is the way back. The chat's own
    // status line may sit inside it, and its click would open its detail
    // block, so this runs first, on the way down.
    this.el.addEventListener("click", (e) => {
      const away = (e.target as HTMLElement).closest<HTMLElement>(".cdash-status.is-away");
      if (!away) return;
      e.stopPropagation();
      e.preventDefault();
      this.act("plan-current", away);
    }, true);
    this.el.addEventListener("input", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !t.closest(".cdash-pl-search")) return;
      this.ui.planSearch = t.value;
      const card = t.closest<HTMLElement>(".cdash-plan");
      if (card) {
        filterPlanList(card, t.value);
        syncPlanListFade(card);
      }
    });
    this.el.addEventListener("scroll", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains("cdash-pl")) syncPlanListFade(t.closest<HTMLElement>(".cdash-plan") ?? t);
    }, true);
    this.el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if ((e.key === "Enter" || e.key === " ") && t.matches(".cdash-status.is-away")) {
        e.preventDefault();
        this.act("plan-current", t);
      } else if ((e.key === "Enter" || e.key === " ") && t.matches("[data-act='strip-expand']")) {
        e.preventDefault();
        this.act("strip-expand", t);
      }
    });
    document.addEventListener("click", this.onDocClick, true);
    document.addEventListener("keydown", this.onKey);
    window.addEventListener(ACTIVE_QUESTION_EVENT, this.onFlushed);
    window.addEventListener(QUESTION_ASK_EVENT, this.onQuestionAsk);

    const msgs = pane.querySelector<HTMLElement>(".session-messages");
    if (msgs) msgs.before(this.el);
    else pane.appendChild(this.el);
    pane.setAttribute(DASH_ATTR, "dashboard");

    if (this.bar && typeof MutationObserver !== "undefined") {
      // The status line shows and hides itself (session-thinking-bar.ts); a
      // running turn with no plan yet still gets a Plan card to host it.
      // Its Stop button's `hidden` also flips when messages get held, which
      // decides whether the line may leave the composer (see barMayMove).
      this.barObserver = new MutationObserver(() => this.schedule());
      this.barObserver.observe(this.bar, { attributes: true, attributeFilter: ["hidden", "class"], subtree: true });
    }
    renderer.onFlushed = this.onFlushed;
    builtHidden.add(renderer);
    void this.subscribePreviews();
    void this.subscribeDrafts();
    this.render();
  }

  /** Coalesces a burst of flushes into one derive. setTimeout, not rAF, for the
   *  same reason as flush-scheduler.ts: rAF stalls in a hidden window. */
  schedule(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.render();
    }, 0);
  }

  /** The status line is up and may sit in the Plan card. Held messages pin it
   *  above the message box: their list opens out of the line itself
   *  (held-messages-render.ts) and belongs by the composer they are sent from. */
  private barMayMove(): boolean {
    if (!this.bar || this.bar.hasAttribute("hidden")) return false;
    return !state.heldMessages?.hasItemsForActive();
  }

  render(): void {
    if (this.disposed) return;
    // The pane was rebuilt for another chat (selectSession wipes it): this
    // dashboard is gone with it, so stop listening.
    if (!this.el.isConnected) {
      this.dispose();
      return;
    }
    // A history replay flushes once per chunk; drawing those half-built states
    // would flash zones the finished replay drops. Its last flush lands after
    // `hydrating` clears, so nothing is missed.
    if (this.renderer.hydrating) return;
    const busy = this.barMayMove();
    const now = Date.now();
    if (this.wasBusy && !busy) this.idleAt = now;
    this.wasBusy = busy;
    this.ensureDrafts();
    const subItems = collectSubItems(this.renderer.sessionId ?? "", state.sessions, this.finishedAt);
    this.refreshFinishTimes(subItems);
    const derived = deriveDashboard({
      messages: this.renderer.messages,
      plans: this.renderer.dashPlans,
      busy,
      answers: this.answers.sideData(),
      // Not loaded yet is not "no subs": the Answers card would call every sub gone.
      subs: state.sessions.some((s) => s.session_id === this.renderer.sessionId) ? subItems : undefined,
      now,
      previews: this.previews,
      sessionId: this.renderer.sessionId,
      draftStore: this.draftStore,
      sections: readSections(getSettings()),
      openCard: this.renderer.sessionId ? activeCardFor(this.renderer.sessionId) : null,
    });
    this.applyUiRules(derived);
    this.keepDraftItems(derived);
    this.renderStripPart(derived);
    this.renderZones(derived, busy);
    this.renderAnswers(derived);
    this.renderSubs(derived);
    this.placeBar(busy);
    const planEl = this.zoneEls.get("plan")?.el;
    if (planEl) syncPlanListFade(planEl);
    if (!this.previewsAsked && this.renderer.sessionId) {
      this.previewsAsked = true;
      void this.loadPreviews();
    }
    this.mountTiles();
    this.ensureQuick(derived);
  }

  // ---- Preview window card ---------------------------------------------------------

  private async loadPreviews(): Promise<void> {
    const sid = this.renderer.sessionId;
    if (!sid) return;
    try {
      const list = await invoke<PreviewMeta[]>("list_previews", { sessionId: scopeRoot(sid) });
      if (this.disposed) return;
      this.previews = Array.isArray(list) ? list : [];
      this.schedule();
    } catch (err) {
      console.warn("[chat-dashboard] list_previews failed", err);
    }
  }

  /** A sub by its name; the main chat as such, since a sub read in place sees its parent's previews too. */
  private readonly previewOwner = (owner: string): string =>
    ownerTag(owner)?.name ?? (owner === scopeRoot(this.renderer.sessionId) ? "Main chat" : "Another chat");

  /** Any push re-reads the list; a burst (a shared mockup's parts) is one read. */
  private async subscribePreviews(): Promise<void> {
    try {
      const un = await getTransport().listen("preview", () => {
        if (this.previewTimer !== null) return;
        this.previewTimer = setTimeout(() => {
          this.previewTimer = null;
          void this.loadPreviews();
        }, 150);
      });
      if (this.disposed) un();
      else this.unlistenPreview = un;
    } catch (err) {
      console.warn("[chat-dashboard] listen(preview) failed", err);
    }
  }

  /** Points each tile's frame at its staged page. The frame is new after every
   *  redraw of the card, so this runs after every render and costs a lookup
   *  once the page is staged. The page is drawn at a fixed size and scaled to
   *  the tile, so the tile reads as the real preview in miniature. */
  private mountTiles(): void {
    for (const tile of this.el.querySelectorAll<HTMLElement>(".cdash-pv-tile")) {
      const id = tile.dataset.pvId ?? "";
      const key = `${id}@${tile.dataset.pvVersion ?? ""}`;
      const frame = tile.querySelector<HTMLIFrameElement>(".cdash-pv-frame");
      if (!frame) continue;
      const width = tile.clientWidth;
      if (width > 0) tile.style.setProperty("--pv-scale", String(width / 1280));
      const cached = this.tileSrc.get(key);
      if (cached) {
        if (frame.getAttribute("src") !== cached) frame.src = cached;
        continue;
      }
      if (this.tileLoading.has(key)) continue;
      this.tileLoading.add(key);
      void (async () => {
        try {
          const snap = await invoke<PreviewSnapshot>("get_preview", { id, sessionId: scopeRoot(this.renderer.sessionId) });
          const src = await invoke<string>("render_preview_doc", { html: buildPreviewDocumentHtml(snap.html) });
          this.tileSrc.set(key, src);
          if (!this.disposed) this.schedule();
        } catch (err) {
          console.warn("[chat-dashboard] preview tile failed", err);
        } finally {
          this.tileLoading.delete(key);
        }
      })();
    }
  }

  // ---- Drafts card -------------------------------------------------------------------

  /** Reads the drafts store whenever the chat names a draft the last read did
   *  not know, so a new draft shows the store's own version label at once. */
  private ensureDrafts(): void {
    const sid = this.renderer.sessionId;
    if (!sid || !sectionOn(readSections(getSettings()), "drafts")) return;
    const ids = draftIdsOf(this.renderer.messages);
    const sig = ids.join(",");
    if (sig === this.draftSig || Date.now() < this.draftRetryAt) return;
    this.draftSig = sig;
    void this.loadDrafts(ids);
  }

  private async loadDrafts(ids: readonly string[]): Promise<void> {
    const sid = this.renderer.sessionId;
    if (!sid) return;
    const req = ++this.draftReq;
    try {
      const view = await invoke<{ drafts: MessageDraft[] }>("list_message_drafts", { sessionId: sid });
      if (this.disposed || req !== this.draftReq) return;
      this.draftFails = 0;
      this.draftStore = { drafts: Array.isArray(view?.drafts) ? view.drafts : [], ids: [...ids], sessionId: sid };
      this.schedule();
    } catch (err) {
      console.warn("[chat-dashboard] list_message_drafts failed", err);
      if (req !== this.draftReq || ++this.draftFails >= 3) return;
      const delay = ChatDashboard.draftRetryMs * 2 ** (this.draftFails - 1);
      this.draftSig = null;
      this.draftRetryAt = Date.now() + delay;
      setTimeout(() => this.schedule(), delay + 50);
    }
  }

  /** A copy, a panel edit or a later revise changes the store: read it again.
   *  Kebab, not the snake_case name the daemon publishes (see chat-draft-card.ts). */
  private async subscribeDrafts(): Promise<void> {
    try {
      const un = await getTransport().listen("message-drafts-changed", () => {
        if (this.draftsTimer !== null) return;
        this.draftsTimer = setTimeout(() => {
          this.draftsTimer = null;
          void this.loadDrafts(draftIdsOf(this.renderer.messages));
        }, 150);
      });
      if (this.disposed) un();
      else this.unlistenDrafts = un;
    } catch (err) {
      console.warn("[chat-dashboard] listen(message-drafts-changed) failed", err);
    }
  }

  private keepDraftItems(state: DashboardState): void {
    this.draftItems.clear();
    const zone = state.left.find((z) => z.id === "drafts");
    if (!zone || zone.id !== "drafts") return;
    for (const d of [...zone.state.toSend, ...zone.state.copied]) this.draftItems.set(d.key, d);
  }

  /** Copy, Edit and the fold chevron of a draft in the Drafts card. Edit hands
   *  the draft to the Drafts panel, which is where drafts are edited. */
  private onDraftClick(e: MouseEvent): boolean {
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>(".cdash-drafts .msg.draft-card[data-dd-key]");
    if (!card || !this.el.contains(card)) return false;
    const item = this.draftItems.get(card.dataset.ddKey ?? "");
    if (!item) return false;
    const copy = target.closest<HTMLElement>("[data-draft-copy]");
    if (copy) {
      const body = card.querySelector<HTMLElement>(".dc-body");
      if (body) copyDraft(body, item.body, copy, item.id ?? undefined, this.renderer.sessionId);
      return true;
    }
    if (target.closest("[data-draft-pop]")) {
      if (item.id) window.dispatchEvent(new CustomEvent(DRAFT_OPEN_EVENT, { detail: { id: item.id } }));
      return true;
    }
    if (target.closest("[data-draft-toggle]")) {
      this.ui.draftOpen[item.key] = !card.classList.contains("open");
      this.render();
      return true;
    }
    return false;
  }

  // ---- Quick views -------------------------------------------------------------------

  /** Looks each quick view up once, when the Links and files card first draws,
   *  so a view with nothing behind it draws muted and says so on hover. A click
   *  reads it again, so this only decides how the button looks. */
  private ensureQuick(state: DashboardState): void {
    const links = state.right.find((z) => z.id === "links");
    this.linkedFiles = links && links.id === "links" ? links.state.files.map((f) => f.path) : [];
    const sid = this.renderer.sessionId;
    if (!links || this.quickAsked || !sid) return;
    this.quickAsked = true;
    for (const q of QUICK_VIEWS) {
      void fetchQuickView(sid, q.id)
        .then((d) => {
          // A plan doc the chat names counts as a plan.
          this.quick[q.id] = d.docs.length > 0 || (q.id === "plan" && this.linkedPlanDoc() !== null);
          if (!this.disposed) this.schedule();
        })
        .catch((err) => console.warn(`[chat-dashboard] quick view ${q.id} lookup failed`, err));
    }
  }

  private linkedPlanDoc(): string | null {
    return this.linkedFiles.find((p) => /plan[^\\/]*\.md$/i.test(p)) ?? null;
  }

  private async openQuick(view: QuickViewId): Promise<void> {
    const sid = this.renderer.sessionId;
    if (!sid) return;
    try {
      const data = await fetchQuickView(sid, view);
      if (view === "plan" && data.docs.length === 0) {
        const linked = this.linkedPlanDoc();
        if (linked) {
          openFileRef(linked);
          return;
        }
      }
      this.quick[view] = data.docs.length > 0;
      openQuickView(data);
      this.schedule();
    } catch (err) {
      console.warn(`[chat-dashboard] quick view ${view} failed`, err);
      openQuickView({ view, title: QUICK_VIEWS.find((q) => q.id === view)?.label ?? view, docs: [], message: "Could not read it just now." });
    }
  }

  /** The instance list changed (sessions-wiring.ts's syncInstances): a sub's
   *  state, model or pin may have moved. */
  onSessionsChanged(): void {
    this.schedule();
  }

  /** Finish times come from the main chat's finish cards (the log outlives a
   *  restart), fetched again only when the set of finished subs changes. */
  private refreshFinishTimes(items: readonly SubCardItem[]): void {
    const sig = items.filter((i) => i.kind === "finished").map((i) => i.id).sort().join(",");
    if (sig === this.finishedSig) return;
    this.finishedSig = sig;
    const sid = this.renderer.sessionId;
    if (!sid || sig === "") return;
    void fetchSubCards(sid).then((cards) => {
      if (this.disposed) return;
      const times = new Map<string, number>();
      for (const c of cards) if (c.kind === "finish" && c.sub_id) times.set(c.sub_id, Math.max(times.get(c.sub_id) ?? 0, c.ts));
      this.finishedAt = times;
      this.schedule();
    });
  }

  private renderSubs(state: DashboardState): void {
    const zone = state.right.find((z) => z.id === "subchats");
    const host = this.zoneEls.get("subchats")?.el.querySelector<HTMLElement>(".sx-host") ?? null;
    if (zone && zone.id === "subchats" && host) this.subs.update(host, zone.state);
    else this.subs.detach();
    // A finished sub folds under "+N earlier" an hour after it finished, with no
    // event to say so: draw again when the next one is due.
    if (this.foldTimer !== null) clearTimeout(this.foldTimer);
    this.foldTimer = null;
    const due = zone && zone.id === "subchats" ? zone.state.foldsAt : null;
    if (due !== null) this.foldTimer = setTimeout(() => this.schedule(), Math.min(Math.max(due - Date.now(), 0) + 50, 2 ** 31 - 1));
  }

  /** UI state that a new derive invalidates. */
  private applyUiRules(state: DashboardState): void {
    const plan = state.right.find((z) => z.id === "plan");
    this.plan = plan && plan.id === "plan" ? plan.state : null;
    const earlier = this.plan?.earlier ?? [];
    // An earlier plan that is gone (a reload of a shorter page) falls back to the current one.
    if (this.ui.planSel !== null && !earlier.some((j) => j.key === this.ui.planSel)) this.ui.planSel = null;
    if (earlier.length === 0) this.ui.planList = false;
    const count = state.strip?.messages.length ?? 0;
    if (this.ui.stripPick !== null && this.ui.stripPick >= count) this.ui.stripPick = null;
  }

  private renderStripPart(state: DashboardState): void {
    const html = renderStrip(state.strip, this.ui);
    if (html === this.stripHtml) return;
    this.stripHtml = html;
    this.stripEl.hidden = html === "";
    this.stripEl.innerHTML = html;
    this.decorate(this.stripEl);
  }

  private renderZones(state: DashboardState, busy: boolean): void {
    const ctx = { ui: this.ui, busy, quick: this.quick, idleAt: this.idleAt, previewOwner: this.previewOwner };
    const live = new Set<ZoneId>();
    for (const [col, zones] of [[this.leftEl, state.left], [this.rightEl, state.right]] as const) {
      zones.forEach((z, i) => {
        live.add(z.id);
        const html = renderZone(z.id, z.state as never, ctx);
        let entry = this.zoneEls.get(z.id);
        if (!entry) {
          const el = document.createElement("div");
          el.className = "cdash-slot";
          el.dataset.zone = z.id;
          entry = { el, html: "" };
          this.zoneEls.set(z.id, entry);
        }
        if (entry.html !== html) {
          // Lift the status line out first: replacing the Plan card's HTML would
          // otherwise drop it from the document along with the old card.
          if (this.bar && entry.el.contains(this.bar)) this.sendBarHome();
          // A redraw mid-typing must not take the plan search box from under Joe.
          const active = document.activeElement;
          const caret = active instanceof HTMLInputElement && entry.el.contains(active) ? active.selectionStart : null;
          entry.el.innerHTML = html;
          entry.html = html;
          this.decorate(entry.el);
          if (z.id === "plan") {
            filterPlanList(entry.el, this.ui.planSearch);
            const input = entry.el.querySelector<HTMLInputElement>(".cdash-pl-search input");
            if (input && caret !== null) {
              input.focus();
              input.setSelectionRange(caret, caret);
            }
          }
        }
        if (col.children[i] !== entry.el) col.insertBefore(entry.el, col.children[i] ?? null);
      });
    }
    for (const [id, entry] of this.zoneEls) {
      if (live.has(id)) continue;
      if (this.bar && entry.el.contains(this.bar)) this.sendBarHome();
      entry.el.remove();
      this.zoneEls.delete(id);
    }
  }

  private renderAnswers(state: DashboardState): void {
    const zone = state.left.find((z) => z.id === "answers");
    const host = this.zoneEls.get("answers")?.el.querySelector<HTMLElement>(".ax-host") ?? null;
    if (zone && zone.id === "answers" && host) this.answers.update(host, zone.state);
    else this.answers.detach();
  }

  /** The status line sits at the foot of the Plan card while that card is
   *  drawn, and back above the message box otherwise. Moving the node keeps its
   *  own listeners (Stop, the detail block) and session-thinking-bar.ts finds it
   *  in the pane wherever it is. */
  private placeBar(mayMove: boolean): void {
    if (!this.bar) return;
    const slot = this.el.querySelector<HTMLElement>("[data-slot='status']");
    // The earlier-plans list hides the foot; a running turn's line (and its
    // Stop) then waits above the message box instead of vanishing with it.
    if (slot && mayMove && !slot.hidden) {
      if (this.bar.parentElement !== slot) slot.appendChild(this.bar);
    } else {
      this.sendBarHome();
    }
  }

  /** Focus is in this dashboard, or nowhere in particular. */
  private ownsFocus(): boolean {
    if (!this.el.isConnected) return false;
    const a = document.activeElement;
    return !a || a === document.body || this.el.contains(a);
  }

  private sendBarHome(): void {
    if (!this.bar || !this.barHome || this.bar.parentElement === this.barHome) return;
    this.barHome.insertBefore(this.bar, this.barHome.querySelector(".session-composer"));
  }

  /** The passes the transcript runs on a freshly built row (chat-dom-renderer.ts). */
  private decorate(root: HTMLElement): void {
    const cwd = this.renderer.paginator.cwdHint;
    void highlightCodeBlocks(root);
    highlightInlineCode(root);
    linkifyDrillRefs(root, root);
    linkifyFilePaths(root);
    void resolveCommitRefs(root, cwd);
    void linkifyTickets(root, cwd);
    if (root.querySelector(".attachment-chip[data-attachment-path]")) void hydrateAttachments(root, this.renderer.sessionId);
  }

  private onClick(e: MouseEvent): void {
    if (this.onDraftClick(e)) return;
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!t || !this.el.contains(t)) return;
    // A link or chip inside Joe's message keeps its own click.
    if (t.dataset.act === "strip-expand" && (e.target as HTMLElement).closest("a, button, .attachment-chip")) return;
    this.act(t.dataset.act!, t);
  }

  private act(name: string, t: HTMLElement): void {
    const ui = this.ui;
    // These two open something else and change nothing drawn here.
    if (name === "quick-view") {
      void this.openQuick(t.dataset.view as QuickViewId);
      return;
    }
    if (name === "open-preview") {
      window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { detail: { slug: t.dataset.slug ?? "" } }));
      return;
    }
    switch (name) {
      case "strip-expand": ui.stripExpanded = !ui.stripExpanded; break;
      case "strip-earlier": ui.earlierOpen = !ui.earlierOpen; break;
      case "strip-pick": ui.stripPick = Number(t.dataset.i); ui.earlierOpen = false; ui.stripExpanded = true; break;
      case "strip-latest": ui.stripPick = null; ui.stripExpanded = false; break;
      case "drafts-copied": ui.copiedOpen = !ui.copiedOpen; break;
      case "pv-others": ui.pvOthersOpen = !ui.pvOthersOpen; break;
      case "step": ui.openStep = ui.openStep === t.dataset.step ? null : (t.dataset.step ?? null); break;
      case "plan-prev":
      case "plan-next":
      case "plan-pick":
      case "plan-list":
      case "plan-current":
        this.planNav(name, t);
        return;
      default: return;
    }
    // The redraw replaces the control that was used; keyboard users keep their place.
    const hadFocus = document.activeElement === t;
    const key = name === "strip-pick" ? "[data-act='strip-expand']" : t.dataset.step !== undefined
      ? `[data-act='step'][data-step="${t.dataset.step.replace(/["\\]/g, "\\$&")}"]` : `[data-act='${name}']`;
    this.render();
    if (hadFocus) this.el.querySelector<HTMLElement>(key)?.focus();
  }

  /** The Plan card's pager: older, newer, a pick from the list, the list itself
   *  (a toggle back to what it was opened over), and back to the current plan.
   *  The body slides the way Joe moved, like the Answers card's thread. */
  private planNav(name: string, t: HTMLElement): void {
    const ui = this.ui;
    const earlier = this.plan?.earlier ?? [];
    const idx = ui.planSel === null ? earlier.length : earlier.findIndex((j) => j.key === ui.planSel);
    let dir: "in-l" | "in-r" = "in-r";
    switch (name) {
      case "plan-prev":
        if (idx <= 0) return;
        ui.planSel = earlier[idx - 1]!.key;
        dir = "in-l";
        break;
      case "plan-next":
        ui.planSel = idx + 1 < earlier.length ? earlier[idx + 1]!.key : null;
        break;
      case "plan-pick":
        ui.planSel = t.dataset.key ?? null;
        ui.planList = false;
        break;
      case "plan-list":
        if (ui.planList) {
          ui.planList = false;
          ui.planSel = ui.planListFrom;
          dir = "in-l";
        } else {
          if (earlier.length === 0) return;
          ui.planListFrom = ui.planSel;
          ui.planList = true;
        }
        break;
      case "plan-current":
        ui.planSel = null;
        ui.planList = false;
        dir = "in-l";
        break;
    }
    ui.openStep = null;
    const hadFocus = document.activeElement === t;
    this.render();
    const body = this.el.querySelector<HTMLElement>(".cdash-plan .cdash-pbody");
    if (body) {
      body.classList.remove("in-l", "in-r");
      void body.offsetWidth;
      body.classList.add(dir);
    }
    if (ui.planList) this.el.querySelector<HTMLInputElement>(".cdash-pl-search input")?.focus();
    else if (hadFocus) {
      const keep = name === "plan-prev" || name === "plan-next" ? name : "plan-list";
      this.el.querySelector<HTMLElement>(`.cdash-plan [data-act='${keep}']:not([disabled])`)?.focus();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.barObserver?.disconnect();
    this.answers.dispose();
    this.subs.dispose();
    if (this.foldTimer !== null) clearTimeout(this.foldTimer);
    this.foldTimer = null;
    this.unlistenPreview?.();
    this.unlistenPreview = null;
    this.unlistenDrafts?.();
    this.unlistenDrafts = null;
    if (this.draftsTimer !== null) clearTimeout(this.draftsTimer);
    this.draftsTimer = null;
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.sendBarHome();
    document.removeEventListener("click", this.onDocClick, true);
    document.removeEventListener("keydown", this.onKey);
    window.removeEventListener(ACTIVE_QUESTION_EVENT, this.onFlushed);
    window.removeEventListener(QUESTION_ASK_EVENT, this.onQuestionAsk);
    if (this.renderer.onFlushed === this.onFlushed) this.renderer.onFlushed = null;
    this.el.remove();
    if (this.pane.getAttribute(DASH_ATTR) === "dashboard" && !this.pane.querySelector(".cdash")) this.pane.removeAttribute(DASH_ATTR);
    if (current?.dash === this) current = { ...current, dash: null };
  }

  /** Test seam: the body element the zones scroll in. */
  get body(): HTMLElement {
    return this.bodyEl;
  }
}

/** The chat window the dashboard currently belongs to (one per app window). */
let current: { pane: HTMLElement; renderer: ChatRenderer; dash: ChatDashboard | null; transcriptOnly: boolean } | null = null;

/** The chat pane was emptied (no chat open): the dashboard goes with it. */
export function detachChatDashboard(): void {
  current?.dash?.dispose();
  current = null;
}

/** Called whenever a renderer is pointed at a pane (active-session-mount.ts's
 *  wireRenderer): draws the dashboard there when the setting says so, and only
 *  then. In Messages view, and on the phone, nothing is added to the pane. */
export function attachChatDashboard(pane: HTMLElement, renderer: ChatRenderer, opts: { transcriptOnly?: boolean } = {}): ChatDashboard | null {
  current?.dash?.dispose();
  // The previous chat's renderer may be retained off-screen; it must not keep
  // driving a dashboard that is no longer on screen.
  if (current && current.renderer !== renderer && current.renderer.onFlushed) current.renderer.onFlushed = null;
  // A read-only external or automated session talks in plain transcript text,
  // with no send_message cards for the zones to read, so it keeps Messages.
  current = { pane, renderer, dash: null, transcriptOnly: !!opts.transcriptOnly };
  if (!dashboardEnabled() || opts.transcriptOnly) {
    showTranscript(renderer);
    return null;
  }
  current.dash = new ChatDashboard(pane, renderer);
  return current.dash;
}

/** The dashboard on screen, if any. */
export function currentChatDashboard(): ChatDashboard | null {
  return current?.dash ?? null;
}

/** Re-applies the setting to the open chat after a change in Settings. */
export function applyChatViewSetting(): void {
  // The pane outlives its chat (a dismount leaves the empty state in it), so
  // the transcript being on screen is what says the chat is still open.
  if (!current || !current.renderer.container.isConnected) return;
  const want = dashboardEnabled() && !current.transcriptOnly;
  if (want && !current.dash) current.dash = new ChatDashboard(current.pane, current.renderer);
  // The same event carries a section switch: redraw so it shows or hides at once.
  else if (want && current.dash) current.dash.schedule();
  else if (!want && current.dash) {
    current.dash.dispose();
    showTranscript(current.renderer);
  }
}

/** Renderers that built rows while the dashboard hid their transcript. */
const builtHidden = new WeakSet<ChatRenderer>();

/** Readies a transcript built while hidden for being seen. A long user message
 *  is measured to decide its "Show more" clamp, and a hidden row measures 0, so
 *  those rows are measured again (a row already clamped keeps its clamp). The
 *  transcript also never kept its place at the bottom. */
export function showTranscript(renderer: ChatRenderer): void {
  if (!builtHidden.has(renderer)) return;
  builtHidden.delete(renderer);
  renderer.messages.forEach((m, i) => {
    const el = renderer.messageEls[i];
    if (m.kind === "user" && el && !el.classList.contains("has-clamp")) delete el.dataset.clampChecked;
  });
  clampUserMessages(renderer.messages, renderer.messageEls);
  scrollToBottom(renderer);
}

if (typeof document !== "undefined") document.addEventListener(CHAT_VIEW_CHANGED, applyChatViewSetting);
