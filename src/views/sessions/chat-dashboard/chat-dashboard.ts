// The chat dashboard for one chat window (docs/chat-dashboard-design.md):
// mounted beside the transcript, never inside it. The ChatRenderer keeps
// building its transcript exactly as in Messages view (hidden by CSS while the
// dashboard shows), so switching views is instant and nothing that reads the
// transcript (pagination, the image gallery, Code mode, the statusbar) changes.
// After every flush the renderer fires onFlushed; this re-derives the zones
// (dashboard-model.ts) and redraws only the zones whose HTML changed.

import type { ChatRenderer } from "../../../shared/chat/chat-renderer";
import { deriveDashboard, type DashboardState, type ZoneId } from "../../../shared/chat/dashboard/dashboard-model";
import { handleAttachmentClick, handleCopyClick, handlePastedLogClick, handleSlashClick, handleTableFullscreen } from "../../../shared/chat/chat-click-handlers";
import { handleCommitRefClick, handleCommitRefKeydown, resolveCommitRefs } from "../../../shared/chat/commit-refs";
import { linkifyTickets } from "../../../shared/chat/ticket-refs";
import { hydrateAttachments } from "../../../shared/chat/attachment-hydrator";
import { clampUserMessages } from "../../../shared/chat/turn-collapse";
import { sessionEvents } from "../../../shared/chat/event-store";
import { state } from "../state";
import { handleDrillAnchorClick, handleDrillClick, linkifyDrillRefs } from "../../../shared/chat/drill-links";
import { handleFileRefClick, handleFileRefContextMenu, handleFileRefKeydown, linkifyFilePaths } from "../../../shared/chat/file-refs";
import { highlightCodeBlocks, highlightInlineCode } from "../../../shared/chat/code-highlighter";
import { scrollToBottom } from "../../../shared/chat/chat-dom-renderer";
import { initialUi, renderStrip, renderZone, type DashUi } from "./dashboard-zones";
import { AnswersCard } from "./answers-card";
import { SubsCard } from "./subs-card";
import { collectSubItems } from "./subs-source";
import { fetchSubCards } from "../../../shared/chat/subchat-cards";
import type { SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import { CHAT_VIEW_CHANGED, dashboardEnabled } from "./chat-view-pref";
import "./chat-dashboard.css";

/** Set on the pane while the dashboard shows; the CSS hides the transcript off it. */
export const DASH_ATTR = "data-chat-view";

export class ChatDashboard {
  readonly el: HTMLElement;
  private readonly stripEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly leftEl: HTMLElement;
  private readonly rightEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly zoneEls = new Map<ZoneId, { el: HTMLElement; html: string }>();
  private stripHtml = "";
  private ui: DashUi = initialUi();
  private resultId: string | null = null;
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
  private readonly onFlushed = (): void => this.schedule();
  private readonly onDocClick = (e: MouseEvent): void => {
    if (!this.ui.earlierOpen || this.stripEl.contains(e.target as Node)) return;
    this.ui.earlierOpen = false;
    this.render();
  };
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.ui.earlierOpen) {
      this.ui.earlierOpen = false;
      this.render();
    }
  };

  constructor(readonly pane: HTMLElement, readonly renderer: ChatRenderer) {
    this.el = document.createElement("div");
    this.el.className = "cdash";
    this.el.innerHTML = `<div class="cdash-strip" hidden></div><div class="cdash-body"><div class="cdash-empty" hidden><i class="ph ph-squares-four"></i>Answers, the plan and anything waiting on you show up here.</div><div class="cdash-grid"><div class="cdash-col cdash-left"></div><div class="cdash-col cdash-right"></div></div></div>`;
    this.stripEl = this.el.querySelector(".cdash-strip")!;
    this.bodyEl = this.el.querySelector(".cdash-body")!;
    this.gridEl = this.el.querySelector(".cdash-grid")!;
    this.leftEl = this.el.querySelector(".cdash-left")!;
    this.rightEl = this.el.querySelector(".cdash-right")!;
    this.emptyEl = this.el.querySelector(".cdash-empty")!;
    this.bar = pane.querySelector<HTMLElement>(".session-thinking");
    this.answers = new AnswersCard({
      sessionId: () => renderer.sessionId,
      cwd: () => renderer.paginator.cwdHint ?? null,
      onSideChange: () => this.schedule(),
      decorate: (root) => this.decorate(root),
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
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if ((e.key === "Enter" || e.key === " ") && t.matches("[data-act='strip-expand']")) {
        e.preventDefault();
        this.act("strip-expand", t);
      }
    });
    document.addEventListener("click", this.onDocClick, true);
    document.addEventListener("keydown", this.onKey);

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
    const subItems = collectSubItems(this.renderer.sessionId ?? "", state.sessions, this.finishedAt);
    this.refreshFinishTimes(subItems);
    const derived = deriveDashboard({ messages: this.renderer.messages, plan: this.renderer.dashPlan, busy, answers: this.answers.sideData(), subs: subItems, now });
    this.applyUiRules(derived);
    this.renderStripPart(derived);
    this.renderZones(derived, busy);
    this.renderAnswers(derived);
    this.renderSubs(derived);
    this.placeBar(busy);
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
    const resultId = plan && plan.id === "plan" ? plan.state.result?.id ?? null : null;
    // A new Result always takes the spot, even if Joe had flipped to the plan.
    if (resultId !== this.resultId) this.ui.showPlan = false;
    this.resultId = resultId;
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
    const ctx = { ui: this.ui, busy };
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
          entry.el.innerHTML = html;
          entry.html = html;
          this.decorate(entry.el);
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
    const leftN = state.left.length;
    const rightN = state.right.length;
    // A quick one-question chat collapses to its answer card. The right column
    // keeps its place even with the left empty, so the Plan never jumps sideways
    // when the first answer lands.
    this.gridEl.classList.toggle("is-single", rightN === 0);
    this.leftEl.hidden = leftN === 0;
    this.rightEl.hidden = rightN === 0;
    // Only once the history is in: an opening chat is not an empty one.
    const sid = this.renderer.sessionId;
    const loaded = !!sid && sessionEvents.isLoaded(sid);
    this.emptyEl.hidden = !loaded || leftN + rightN > 0 || state.strip !== null;
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
    if (slot && mayMove) {
      if (this.bar.parentElement !== slot) slot.appendChild(this.bar);
    } else {
      this.sendBarHome();
    }
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
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!t || !this.el.contains(t)) return;
    // A link or chip inside Joe's message keeps its own click.
    if (t.dataset.act === "strip-expand" && (e.target as HTMLElement).closest("a, button, .attachment-chip")) return;
    this.act(t.dataset.act!, t);
  }

  private act(name: string, t: HTMLElement): void {
    const ui = this.ui;
    switch (name) {
      case "strip-expand": ui.stripExpanded = !ui.stripExpanded; break;
      case "strip-earlier": ui.earlierOpen = !ui.earlierOpen; break;
      case "strip-pick": ui.stripPick = Number(t.dataset.i); ui.earlierOpen = false; ui.stripExpanded = true; break;
      case "strip-latest": ui.stripPick = null; ui.stripExpanded = false; break;
      case "show-plan": ui.showPlan = true; break;
      case "show-result": ui.showPlan = false; break;
      case "step": ui.openStep = ui.openStep === t.dataset.step ? null : (t.dataset.step ?? null); break;
      default: return;
    }
    // The redraw replaces the control that was used; keyboard users keep their place.
    const hadFocus = document.activeElement === t;
    const key = name === "strip-pick" ? "[data-act='strip-expand']" : t.dataset.step !== undefined
      ? `[data-act='step'][data-step="${t.dataset.step.replace(/["\\]/g, "\\$&")}"]` : `[data-act='${name}']`;
    this.render();
    if (hadFocus) this.el.querySelector<HTMLElement>(key)?.focus();
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
    this.sendBarHome();
    document.removeEventListener("click", this.onDocClick, true);
    document.removeEventListener("keydown", this.onKey);
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
