// The chat dashboard for one chat window (docs/chat-dashboard-design.md):
// mounted beside the transcript, never inside it. The ChatRenderer keeps
// building its transcript exactly as in Messages view (hidden by CSS while the
// dashboard shows), so switching views is instant and nothing that reads the
// transcript (pagination, the image gallery, Code mode, the statusbar) changes.
// After every flush the renderer fires onFlushed; this re-derives the zones
// (dashboard-model.ts) and redraws only the zones whose HTML changed.

import type { ChatRenderer } from "../../../shared/chat/chat-renderer";
import { QUESTION_SETTLED_EVENT, QuestionLiveness } from "./question-liveness";
import { cardQuestionTexts } from "../../../shared/chat/question-texts";
import { AUQ_SKIPPED_TEXT } from "../../../shared/chat/chat-event-to-message";
import { flushRenderNow } from "../../../shared/chat/flush-scheduler";
import { attachTabOf, deriveDashboard, deriveStrip, isOpenQuestion, sectionOn, type DashboardState, type DoneTask, type ZoneId } from "../../../shared/chat/dashboard/dashboard-model";
import { HistoryPrefixSource } from "./history-prefix-source";
import type { DashboardRows } from "../../../shared/chat/dashboard/history-prefix";
import { handleAttachmentClick, handleCopyClick, handlePastedLogClick, handleSlashClick, handleTableFullscreen } from "../../../shared/chat/chat-click-handlers";
import { createHandleBlockImageClick } from "../../../shared/chat/chat-renderer-click-handlers";
import { handleCommitRefClick, handleCommitRefKeydown, resolveCommitRefs } from "../../../shared/chat/commit-refs";
import { linkifyTickets } from "../../../shared/chat/ticket-refs";
import { hydrateAttachments } from "../../../shared/chat/attachment-hydrator";
import { clampUserMessages } from "../../../shared/chat/turn-collapse";
import { state } from "../state";
import { handleDrillAnchorClick, handleDrillClick, linkifyDrillRefs } from "../../../shared/chat/drill-links";
import { handleFileRefClick, handleFileRefContextMenu, handleFileRefKeydown, linkifyFilePaths } from "../../../shared/chat/file-refs";
import { createShownBadlyContextMenu } from "../../../shared/chat/shown-badly";
import { highlightCodeBlocks, highlightInlineCode } from "../../../shared/chat/code-highlighter";
import { scrollToBottom } from "../../../shared/chat/chat-dom-renderer";
import { initialUi, renderStrip, renderZone, type DashUi, type QuickViewId } from "./dashboard-zones";
import { filterPlanList, syncPlanListFade } from "./plan-card";
import type { PlanState } from "../../../shared/chat/dashboard/dashboard-model";
import { AnswersCard } from "./answers-card";
import { sendRevision } from "../drafts-revise";
import { QUESTION_ASK_EVENT, type QuestionAsk } from "../question-ask";
import { privateAskEnabled } from "../private-ask";
import { HOST_ID } from "../permission-modal/host";
import { SubsCard } from "./subs-card";
import { PicksCard } from "./picks-card";
import { TestProgressCard } from "./test-progress-card";
import { RunSource } from "./run-source";
import { RunCard } from "./run-card";
import { collectSubItems } from "./subs-source";
import { countSubs, type SubCounts } from "../../../shared/chat/dashboard/subs-model";
import { fetchSubCards } from "../../../shared/chat/subchat-cards";
import type { SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import { CHAT_VIEW_CHANGED, dashboardEnabled, readSections } from "./chat-view-pref";
import { PreviewTiles } from "./preview-tiles";
import { AttachmentImages } from "./attachment-images";
import { ATTACHMENT_SETTLED_EVENT } from "../../../shared/chat/attachment-hydrator";
import { handleFileRowEvent } from "./file-row-preview";
import { QuickViews } from "./quick-views";
import { invoke } from "../../../shared/ipc";
import { getSettings } from "../../../shared/state";
import { getTransport } from "../../../shared/transport";
import { PREVIEW_OPEN_EVENT } from "../../../shared/chat/chat-preview-card";
import type { MessageDraft } from "../../../types/ipc.generated";
import { draftIdsOf, type DraftItem, type DraftStoreSide } from "../../../shared/chat/dashboard/drafts-model";
import { DRAFT_OPEN_EVENT, copyDraft } from "../../../shared/chat/chat-draft-card";
import { ACTIVE_QUESTION_EVENT, activeCardFor, expandActiveCard } from "../permission-modal/question-state";
import { dismiss, dismissedFor } from "./waiting-dismissed";
import { attachSubHover, type SubHoverResolver } from "./sub-hover";
import { closeChat } from "../close-chat";
import { requestTodoOpen } from "../backlog-panel/backlog-open-event";
import { ctxStatusCache } from "../session-statusbar-helpers";
import { contextChipHtml } from "../statusbar-chips";
import { tierLabel } from "../../../shared/model-name";
import type { ContextStatus } from "../../../types/ipc.generated";
import { fillAgo } from "./done-card";
import "./chat-dashboard.css";
import "./dashboard-extras.css";

/** How often the Done rows' age text is re-read; a label changes once a minute, so a quarter
 *  minute keeps "just now" from lingering past its minute. */
const AGO_TICK_MS = 15_000;

/** How long a dismissed Done row animates out before it leaves the derive (done-card.css, dn-leave). */
const DONE_LEAVE_MS = 200;

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
  /** The Plan card's foot counts these; null when the chat has no unfinished sub. */
  private subCounts: SubCounts | null = null;
  private wasBusy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private barObserver: MutationObserver | null = null;
  /** The chat's status line, and where it lives when the Plan card is not drawn. */
  private readonly bar: HTMLElement | null;
  private readonly barHome: HTMLElement | null;
  private disposed = false;
  /** Patches the Done rows' "20 min ago" in place; no redraw, so no motion replays. */
  private agoTimer: ReturnType<typeof setInterval> | null = null;
  /** The Answers card keeps its own DOM inside the zone's host (answers-card.ts). */
  private readonly answers: AnswersCard;
  /** So does the Subchats card (subs-card.ts). */
  private readonly subs: SubsCard;
  /** The Autopilot picks card (picks-card.ts). */
  private readonly picks: PicksCard;
  /** The Test progress card (test-progress-card.ts). */
  private readonly tests: TestProgressCard;
  /** The run plan the daemon holds for this chat (run-source.ts), drawn by the Plan card's run section (run-card.ts). */
  private readonly runSource: RunSource;
  private readonly runCard: RunCard;
  /** The rows from above the loaded history page (history-prefix-source.ts). */
  private readonly history: HistoryPrefixSource;
  /** Settles open question cards no daemon prompt answers for (question-liveness.ts). */
  private readonly liveness: QuestionLiveness;
  /** When each sub last finished, from the main chat's finish cards. */
  private finishedAt: ReadonlyMap<string, number> = new Map();
  private finishedSig = "";
  /** The Done card's subs as last drawn, for the avatar hover card. */
  private finishedSubs = new Map<string, SubCardItem>();
  /** The Done card's tasks as last drawn, by key: what a dismiss closes. */
  private doneTasks = new Map<string, DoneTask>();
  /** Subs Joe dismissed whose close is in flight or done: left out of the derive until the
   *  instance list drops them, or put back when the close fails. */
  private doneHidden = new Set<string>();
  /** The finish time each finished sub's context was read for: a sub that finishes
   *  again is read again, so the chip says what it ended with this time. */
  private ctxReadFor = new Map<string, number | null>();
  /** The Previews tab's list and tiles (preview-tiles.ts). */
  private readonly previews: PreviewTiles;
  /** The Images tab's gallery collection and thumbnails (attachment-images.ts). */
  private readonly images: AttachmentImages;
  /** The quick-view buttons (quick-views.ts). */
  private readonly quickViews: QuickViews;
  /** The Waiting items Joe removed in this chat (waiting-dismissed.ts), read
   *  once per chat id: the pane is rebuilt when it shows another chat. */
  private dismissed: { sid: string | null; keys: Set<string> } = { sid: null, keys: new Set() };
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
  private readonly onFlushed = (): void => this.schedule();
  /** A card settled by a click on it (sessions.ts): drop it from the derive now, whichever page of history holds its row. */
  private readonly onSettled = (e: Event): void => {
    const d = (e as CustomEvent<{ sessionId?: string; id?: string }>).detail;
    if (!d?.id || d.sessionId !== this.renderer.sessionId) return;
    this.liveness.settled.add(d.id);
    this.schedule();
  };
  private readonly onDocClick = (e: MouseEvent): void => {
    if (!this.ui.earlierOpen || this.stripEl.contains(e.target as Node)) return;
    this.ui.earlierOpen = false;
    this.render();
  };
  /** A question card's Ask (question-ask.ts). The card sits in this pane's
   *  composer, so the dashboard of the pane holding it takes the ask. */
  private readonly onQuestionAsk = (e: Event): void => {
    const card = document.getElementById(HOST_ID);
    if (!privateAskEnabled() || this.disposed || e.defaultPrevented || !this.el.isConnected || !card || !this.pane.contains(card)) return;
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
      earlierDetails: (message) => {
        const all = renderer.messages;
        const at = all.indexOf(message);
        return (at < 0 ? all : all.slice(0, at)).flatMap((m) => m.details ?? []);
      },
      expandQuestion: (promptId) => {
        const sid = renderer.sessionId;
        // The card Joe asked from, not whichever card this chat shows now: it may have been answered elsewhere.
        if (promptId) expandActiveCard({ id: promptId });
        else if (sid) expandActiveCard({ sessionId: sid });
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
    this.picks = new PicksCard({
      sessionId: () => renderer.sessionId ?? null,
      schedule: () => this.schedule(),
      // The owner twice: a gone owner must not fall back to a sub, which cannot act on a pick.
      send: (text, ownerId) => sendRevision(ownerId, ownerId, text),
    });
    this.tests = new TestProgressCard({ sessionId: () => renderer.sessionId ?? null, schedule: () => this.schedule() });
    this.runSource = new RunSource({ sessionId: () => renderer.sessionId ?? null, schedule: () => this.schedule() });
    this.runCard = new RunCard({
      openSub: async (subId) => {
        const { subchatNavFor } = await import("../active-session");
        await subchatNavFor(pane).open(subId);
      },
      clear: () => this.runSource.clear(),
    });
    this.previews = new PreviewTiles({ sessionId: () => renderer.sessionId ?? null, schedule: () => this.schedule() });
    this.images = new AttachmentImages(renderer);
    this.quickViews = new QuickViews({ sessionId: () => renderer.sessionId ?? null, schedule: () => this.schedule() });
    this.barHome = this.bar?.parentElement ?? null;
    this.history = new HistoryPrefixSource(renderer, () => this.schedule());
    this.liveness = new QuestionLiveness({
      sessionId: () => renderer.sessionId ?? null,
      mirrored: () => !!state.sessions.find((s) => s.session_id === renderer.sessionId)?.machine,
      onScreenId: () => (renderer.sessionId ? activeCardFor(renderer.sessionId)?.id ?? null : null),
      settle: async (card) => {
        const sid = renderer.sessionId;
        if (!sid || !card.id) return;
        const { settleQuestionCard } = await import("../permission-modal/dismiss-open-questions");
        if (await settleQuestionCard(renderer, sid, card.id, cardQuestionTexts(card), card.id)) flushRenderNow(renderer);
      },
      changed: () => this.schedule(),
    });

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
    // Before the shared handlers: a Links and files row opens in the Preview panel.
    this.el.addEventListener("click", (e) => handleFileRowEvent(e, () => renderer.sessionId ?? null));
    this.el.addEventListener("keydown", (e) => handleFileRowEvent(e, () => renderer.sessionId ?? null));
    this.el.addEventListener("click", handleFileRefClick);
    this.el.addEventListener("contextmenu", handleFileRefContextMenu);
    // Its cards are the transcript's rows, so "Shown badly" finds them in the same list.
    this.el.addEventListener("contextmenu", createShownBadlyContextMenu(() => this.renderer));
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
      } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && t.matches(".cdash-ltab")) {
        this.tabKey(e, t);
      } else if (e.key === " " && t.matches(".cdash-done button, .cdash-links button, .cdash-plan .rn-host button")) {
        // Space presses the focused Done row, Run lane or "Then" or Attachments tab and row; stopping it here keeps the composer's stray-input
        // relay (a document listener) from typing the space into the message box and cancelling the click.
        e.stopPropagation();
      }
    });
    document.addEventListener("click", this.onDocClick, true);
    document.addEventListener("keydown", this.onKey);
    window.addEventListener(ACTIVE_QUESTION_EVENT, this.onFlushed);
    window.addEventListener(QUESTION_SETTLED_EVENT, this.onSettled);
    window.addEventListener(ATTACHMENT_SETTLED_EVENT, this.onFlushed);
    window.addEventListener(QUESTION_ASK_EVENT, this.onQuestionAsk);

    const msgs = pane.querySelector<HTMLElement>(".session-messages");
    if (msgs) msgs.before(this.el);
    else pane.appendChild(this.el);
    pane.setAttribute(DASH_ATTR, "dashboard");

    if (this.bar && typeof MutationObserver !== "undefined") {
      // The status line shows and hides itself (session-thinking-bar.ts); a
      // running turn with no plan yet still gets a Plan card to host it.
      // Its Stop button's `hidden` also flips when messages get held, which
      // decides whether the line may leave the composer (see barMayMove). Its
      // `busy` class is what the foot reads (see barBusy).
      this.barObserver = new MutationObserver(() => this.schedule());
      this.barObserver.observe(this.bar, { attributes: true, attributeFilter: ["hidden", "class"], subtree: true });
    }
    renderer.onFlushed = this.onFlushed;
    this.agoTimer = setInterval(() => fillAgo(this.el), AGO_TICK_MS);
    builtHidden.add(renderer);
    void this.previews.subscribe();
    void this.picks.subscribe();
    void this.tests.subscribe();
    void this.runSource.subscribe();
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

  /** The status line is up and says a turn runs. session-thinking-bar.ts decides
   *  (its `busy` class) and is the one authority: the foot's resting line and this
   *  flag read the same fact, so the foot never says "idle" beside a running line.
   *  The line is also up, not busy, to anchor held messages ("Waiting to send");
   *  that is no status, so the foot keeps its own line then. */
  private barBusy(): boolean {
    return !!this.bar && !this.bar.hasAttribute("hidden") && this.bar.classList.contains("busy");
  }

  /** The running line may sit in the Plan card. Held messages pin it above the
   *  message box: their list opens out of the line itself (held-messages-render.ts)
   *  and belongs by the composer they are sent from. The foot then draws nothing,
   *  so one status line shows, not two. */
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
    const busy = this.barBusy();
    const now = Date.now();
    if (this.wasBusy && !busy) this.idleAt = now;
    this.wasBusy = busy;
    // The zones read the chat's whole history (older rows rebuilt from the
    // transcript's digest); Joe's strip keeps to the loaded rows, whose pasted
    // images are whole, where the digest's large ones are elided.
    const rows = this.history.rows();
    this.ensureDrafts(rows.messages);
    // A card nothing can answer any more is settled, and read as skipped at once (question-liveness.ts).
    const messages = this.liveness.apply(rows.messages, AUQ_SKIPPED_TEXT);
    this.liveness.check(this.unreachableOpenCards(messages), now);
    const subItems = collectSubItems(this.renderer.sessionId ?? "", state.sessions, this.finishedAt);
    this.subCounts = countSubs(subItems);
    this.refreshFinishTimes(subItems);
    const derived = deriveDashboard({
      messages,
      plans: rows.plans,
      busy,
      answers: this.answers.sideData(),
      // Not loaded yet is not "no subs": the Answers card would call every sub gone.
      subs: state.sessions.some((s) => s.session_id === this.renderer.sessionId) ? this.withoutHidden(subItems) : undefined,
      now,
      previews: this.previews.list,
      // Reading the gallery's collection walks every message, so a chat that switched the tab off skips it.
      images: sectionOn(readSections(getSettings()), "images") ? this.images.collect() : [],
      picks: this.picks.sideData(),
      testProgress: this.tests.sideData(),
      run: this.runSource.sideData(),
      sessionId: this.renderer.sessionId,
      draftStore: this.draftStore,
      sections: readSections(getSettings()),
      openCard: this.renderer.sessionId ? activeCardFor(this.renderer.sessionId) : null,
      dismissed: this.dismissedKeys(),
      subCards: this.renderer.subCardPool,
    });
    if (rows.messages !== this.renderer.messages) derived.strip = deriveStrip({ messages: this.renderer.messages, plans: [] });
    this.applyUiRules(derived);
    this.keepDraftItems(derived);
    this.renderStripPart(derived);
    this.renderZones(derived, busy);
    this.renderAnswers(derived);
    this.renderSubs(derived);
    this.renderPicks(derived);
    this.renderTests(derived);
    this.renderRun(derived);
    this.ensureFinishedCtx(derived);
    this.placeBar(this.barMayMove());
    const planEl = this.zoneEls.get("plan")?.el;
    if (planEl) syncPlanListFade(planEl);
    this.previews.ensureLoaded();
    this.picks.ensureLoaded();
    this.runSource.ensureLoaded();
    this.previews.mount(this.el);
    this.images.mount(this.el);
    this.quickViews.ensure(derived);
  }

  /** The open question cards a click cannot bring back: reopening rebuilds a card from the
   *  loaded transcript, so only a card above the loaded page (a row of the history prefix)
   *  is out of reach once the daemon holds no prompt for it. */
  private unreachableOpenCards(messages: DashboardRows["messages"]): DashboardRows["messages"] {
    const open = messages.filter(isOpenQuestion);
    if (open.length === 0) return open;
    const loaded = new Set(this.renderer.messages.filter((m) => m.kind === "question").map((m) => m.id));
    return open.filter((m) => !loaded.has(m.id));
  }

  // ---- Drafts card -------------------------------------------------------------------

  /** Reads the drafts store whenever the chat names a draft the last read did
   *  not know, so a new draft shows the store's own version label at once. */
  private ensureDrafts(messages: DashboardRows["messages"]): void {
    const sid = this.renderer.sessionId;
    if (!sid || !sectionOn(readSections(getSettings()), "drafts")) return;
    // Every row the Drafts card reads, those above the loaded page too: a draft
    // deleted from the store is told apart by its id being asked for.
    const ids = draftIdsOf(messages);
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
          void this.loadDrafts(draftIdsOf(this.history.rows().messages));
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

  private renderPicks(state: DashboardState): void {
    const zone = state.left.find((z) => z.id === "picks");
    const host = this.zoneEls.get("picks")?.el.querySelector<HTMLElement>(".pk-host") ?? null;
    if (zone && zone.id === "picks" && host) this.picks.update(host, zone.state);
    else this.picks.detach();
  }

  private renderTests(state: DashboardState): void {
    const zone = state.right.find((z) => z.id === "tests");
    const host = this.zoneEls.get("tests")?.el.querySelector<HTMLElement>(".tp-host") ?? null;
    if (zone && zone.id === "tests" && host) this.tests.update(host, zone.state);
    else this.tests.detach();
  }

  private renderRun(state: DashboardState): void {
    const zone = state.right.find((z) => z.id === "plan");
    const host = this.zoneEls.get("plan")?.el.querySelector<HTMLElement>(".rn-host") ?? null;
    if (zone && zone.id === "plan" && zone.state.run && host) this.runCard.update(host, zone.state.run);
    else this.runCard.detach();
  }

  private renderSubs(state: DashboardState): void {
    const zone = state.left.find((z) => z.id === "subchats");
    const host = this.zoneEls.get("subchats")?.el.querySelector<HTMLElement>(".sx-host") ?? null;
    if (zone && zone.id === "subchats" && host) this.subs.update(host, zone.state);
    else this.subs.detach();
  }

  /** What each finished sub ended with: its context figure, read once per finish
   *  (context_status; a sub whose transcript cannot be read just shows no chip). */
  private ensureFinishedCtx(state: DashboardState): void {
    const zone = state.right.find((z) => z.id === "done");
    const tasks = zone && zone.id === "done" ? zone.state.tasks : [];
    this.doneTasks = new Map(tasks.map((t) => [t.key, t]));
    const items = tasks.flatMap((t) => t.subs);
    this.finishedSubs = new Map(items.map((it) => [it.sub.id, it.sub]));
    for (const { sub } of items) {
      if (this.ctxReadFor.has(sub.id) && this.ctxReadFor.get(sub.id) === sub.finishedAt) continue;
      this.ctxReadFor.set(sub.id, sub.finishedAt);
      void invoke<ContextStatus | null>("context_status", { sessionId: sub.id })
        .then((c) => {
          if (!c || this.disposed) return;
          ctxStatusCache.set(sub.id, c);
          this.schedule();
        })
        .catch(() => { /* no transcript to measure: the row shows no chip */ });
    }
  }

  private ctxPct = (subId: string): number | null => ctxStatusCache.get(subId)?.pct_used ?? null;

  private ctxChip = (subId: string): string => {
    const c = ctxStatusCache.get(subId);
    return c ? contextChipHtml(c, false) : "";
  };

  /** The tray's avatar hover card: the name and state of the sub. */
  private finishedHover: SubHoverResolver = (id) => {
    const it = this.finishedSubs.get(id);
    if (!it?.hover) return null;
    return { name: it.name, tier: tierLabel(it.model, it.effort), kind: it.kind, hover: it.hover, startedAt: it.startedAt };
  };

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
    const ctx = { ui: this.ui, busy, quick: this.quickViews.has, idleAt: this.idleAt, subs: this.subCounts, previewOwner: this.previews.ownerName, ctxChip: this.ctxChip, ctxPct: this.ctxPct };
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
          // The slot outlives its redraws, so the hover card is wired once per slot.
          if (z.id === "done") attachSubHover(el, this.finishedHover);
        }
        if (entry.html !== html) {
          // Lift the status line out first: replacing the Plan card's HTML would
          // otherwise drop it from the document along with the old card.
          if (this.bar && entry.el.contains(this.bar)) this.sendBarHome();
          // A redraw mid-typing must not take the plan search box from under Joe.
          const active = document.activeElement;
          const caret = active instanceof HTMLInputElement && entry.el.contains(active) ? active.selectionStart : null;
          // The Links and files list scrolls inside its card: a redraw of the same tab
          // keeps Joe's place in it instead of jumping back to the top.
          const list = entry.el.querySelector<HTMLElement>(".cdash-llist");
          const listAt = list ? { tab: list.dataset.tab, top: list.scrollTop } : null;
          const done = entry.el.querySelector<HTMLElement>(".dn-list");
          const doneTop = done ? done.scrollTop : null;
          // The run section patches its own DOM inside a fixed host, so a redraw of the Plan card
          // carries that host over: rebuilding it would replay every lane and shut the "Then" row.
          const runHost = z.id === "plan" ? entry.el.querySelector<HTMLElement>(".rn-host") : null;
          const runFocus = runHost && runHost.contains(active) ? (active as HTMLElement) : null;
          entry.el.innerHTML = html;
          entry.html = html;
          const runSlot = runHost ? entry.el.querySelector<HTMLElement>(".rn-host") : null;
          if (runHost && runSlot) {
            runSlot.replaceWith(runHost);
            runFocus?.focus({ preventScroll: true });
          }
          const doneNow = doneTop !== null ? entry.el.querySelector<HTMLElement>(".dn-list") : null;
          if (doneNow && doneTop !== null) doneNow.scrollTop = doneTop;
          const redrawn = listAt && entry.el.querySelector<HTMLElement>(".cdash-llist");
          if (redrawn && redrawn.dataset.tab === listAt.tab) redrawn.scrollTop = listAt.top;
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

  private dismissedKeys(): Set<string> {
    const sid = this.renderer.sessionId ?? null;
    if (this.dismissed.sid !== sid) this.dismissed = { sid, keys: dismissedFor(sid) };
    return this.dismissed.keys;
  }

  private dismissWaiting(keys: string[]): void {
    if (keys.length === 0) return;
    for (const k of keys) this.dismissedKeys().add(k);
    dismiss(this.renderer.sessionId, keys);
    this.render();
  }

  /** The subs the derive sees: those Joe dismissed are gone at once, whatever the
   *  daemon has answered. An entry leaves the set once the instance list dropped the
   *  sub, so it cannot outlive the row it hid. */
  private withoutHidden(items: readonly SubCardItem[]): SubCardItem[] {
    const present = new Set(items.map((i) => i.id));
    for (const id of this.doneHidden) if (!present.has(id)) this.doneHidden.delete(id);
    return items.filter((i) => !this.doneHidden.has(i.id));
  }

  /** Dismiss closes a task's finished subs (the app's own Close each: the process stops and
   *  the chat stays in history, so a message to it wakes it again). Optimistic: the row
   *  animates out at once and the closes run in the background; a close that fails
   *  puts its row back. */
  private dismissDone(keys: string[]): void {
    // A sub already leaving or hidden is closing in flight: a second dismiss must not close it twice.
    const ids = keys.flatMap((k) => (this.doneTasks.get(k)?.subs ?? [])
      .filter((i) => !i.sub.closing && !this.ui.doneLeaving.has(i.sub.id) && !this.doneHidden.has(i.sub.id))
      .map((i) => i.sub.id));
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const failed = new Set<string>();
    const putBack = (id: string): void => {
      failed.add(id);
      this.ui.doneLeaving.delete(id);
      this.doneHidden.delete(id);
      this.schedule();
    };
    if (this.ui.doneOpen && keys.includes(this.ui.doneOpen)) this.ui.doneOpen = null;
    if (this.ui.doneCard && idSet.has(this.ui.doneCard)) this.ui.doneCard = null;
    for (const id of ids) this.ui.doneLeaving.add(id);
    this.render();
    // The exit animation's length: the rows leave the derive after it.
    window.setTimeout(() => {
      for (const id of ids) {
        // A close that already failed put its row back, and a newer dismiss may own `doneLeaving` now.
        if (failed.has(id)) continue;
        this.ui.doneLeaving.delete(id);
        this.doneHidden.add(id);
      }
      this.schedule();
    }, DONE_LEAVE_MS);
    for (const id of ids) {
      void closeChat(id).then((ok) => { if (!ok) putBack(id); }, () => putBack(id));
    }
  }

  private act(name: string, t: HTMLElement): void {
    const ui = this.ui;
    const shownTab = this.el.querySelector<HTMLElement>(".cdash-ltab.on")?.dataset.tab;
    // These two open something else and change nothing drawn here.
    if (name === "quick-view") {
      void this.quickViews.open(t.dataset.view as QuickViewId);
      return;
    }
    if (name === "open-image") {
      this.images.open(Number(t.dataset.index));
      return;
    }
    if (name === "open-preview") {
      window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { detail: { slug: t.dataset.slug ?? "" } }));
      return;
    }
    if (name === "result-dismiss") {
      // Got it shares the Waiting removals' store: both are a message Joe has seen.
      this.dismissWaiting([t.dataset.wkey ?? ""].filter(Boolean));
      return;
    }
    if (name === "done-dismiss") {
      this.dismissDone([t.dataset.task ?? ""]);
      return;
    }
    if (name === "done-clear") {
      this.dismissDone([...this.doneTasks.keys()]);
      return;
    }
    if (name === "done-todo") {
      requestTodoOpen(t.dataset.todo ?? "");
      return;
    }
    if (name === "wait-dismiss" || name === "wait-clear") {
      // Clear all removes every removable item of its own zone, read off the
      // drawn cards so it never reaches one Joe cannot see.
      const xs = name === "wait-clear"
        ? [...(t.closest(".cdash-zone")?.querySelectorAll<HTMLElement>("[data-act='wait-dismiss']") ?? [])]
        : [t];
      this.dismissWaiting(xs.map((x) => x.dataset.wkey ?? "").filter(Boolean));
      return;
    }
    switch (name) {
      case "strip-expand": ui.stripExpanded = !ui.stripExpanded; break;
      case "strip-earlier": ui.earlierOpen = !ui.earlierOpen; break;
      case "strip-pick": ui.stripPick = Number(t.dataset.i); ui.earlierOpen = false; ui.stripExpanded = true; break;
      case "strip-latest": ui.stripPick = null; ui.stripExpanded = false; break;
      case "drafts-copied": ui.copiedOpen = !ui.copiedOpen; break;
      case "pv-others": ui.pvOthersOpen = !ui.pvOthersOpen; break;
      case "links-tab": ui.linksTab = attachTabOf(t.dataset.tab); break;
      case "result-toggle": ui.resultOpen = ui.resultOpen === t.dataset.wkey ? null : (t.dataset.wkey ?? null); break;
      case "done-open": ui.doneOpen = ui.doneOpen === t.dataset.task ? null : (t.dataset.task ?? null); break;
      case "done-card": ui.doneCard = ui.doneCard === t.dataset.sub ? null : (t.dataset.sub ?? null); break;
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
    // A chat's finish card and its avatar share one action: the focusable one is the row's button.
    const key = name === "done-card" ? `.dn-sub-main[data-act='done-card'][data-sub="${CSS.escape(t.dataset.sub ?? "")}"]` : t.dataset.task !== undefined ? `[data-act='${name}'][data-task="${t.dataset.task.replace(/["\\]/g, "\\$&")}"]` : name === "strip-pick" ? "[data-act='strip-expand']" : t.dataset.step !== undefined
      ? `[data-act='step'][data-step="${t.dataset.step.replace(/["\\]/g, "\\$&")}"]`
      // The two tabs share one action, so the picked one is found by its tab id.
      : name === "links-tab" ? `[data-act='links-tab'][data-tab="${ui.linksTab}"]` : `[data-act='${name}']`;
    this.render();
    if (hadFocus) this.el.querySelector<HTMLElement>(key)?.focus();
    // The redraw is a new element, so the incoming list plays its one-shot fade here, not from the
    // card's HTML (which would differ on the next draw and replace the card for nothing).
    if (name === "links-tab" && t.dataset.tab !== shownTab) this.playTabIn();
  }

  /** Fades the Attachments list in after a tab switch; the class leaves at `animationend` so no later
   *  class change replays it. */
  private playTabIn(): void {
    const list = this.el.querySelector<HTMLElement>(".cdash-links .cdash-llist");
    if (!list) return;
    list.classList.add("is-in");
    list.addEventListener("animationend", () => list.classList.remove("is-in"), { once: true });
  }

  /** Arrow keys, Home and End move between the Attachments tabs the way a tab list does. */
  private tabKey(e: KeyboardEvent, t: HTMLElement): void {
    const tabs = [...(t.closest(".cdash-ltabs")?.querySelectorAll<HTMLElement>(".cdash-ltab") ?? [])];
    const at = tabs.indexOf(t);
    if (at < 0) return;
    const to = e.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(at - 1 + tabs.length) % tabs.length] : e.key === "Home" ? tabs[0] : tabs[tabs.length - 1];
    if (!to || to === t) return;
    e.preventDefault();
    to.focus();
    this.act("links-tab", to);
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
    if (this.agoTimer !== null) clearInterval(this.agoTimer);
    this.agoTimer = null;
    this.barObserver?.disconnect();
    this.answers.dispose();
    this.subs.dispose();
    this.picks.dispose();
    this.tests.dispose();
    this.runSource.dispose();
    this.runCard.dispose();
    this.liveness.dispose();
    this.previews.dispose();
    this.quickViews.dispose();
    this.history.dispose();
    this.unlistenDrafts?.();
    this.unlistenDrafts = null;
    if (this.draftsTimer !== null) clearTimeout(this.draftsTimer);
    this.draftsTimer = null;
    this.sendBarHome();
    document.removeEventListener("click", this.onDocClick, true);
    document.removeEventListener("keydown", this.onKey);
    window.removeEventListener(ACTIVE_QUESTION_EVENT, this.onFlushed);
    window.removeEventListener(QUESTION_SETTLED_EVENT, this.onSettled);
    window.removeEventListener(ATTACHMENT_SETTLED_EVENT, this.onFlushed);
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
