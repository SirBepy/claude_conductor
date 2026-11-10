// The chat dashboard's Answers card (docs/chat-dashboard-design.md, "Answers
// card (approved 2026-11-10)"), ported from the approved board
// (.for_bepy/mockups/mockup-answers.ts, round 17) with its measured numbers.
//
// One card holds everything: the newest unread answer at a fixed 210px rest,
// Got it walking back through the unread ones to All caught up, Read more
// opening the rewritten question and the full text, History as the command
// palette, and threads opening in place. A thread is an Ask thread: follow-ups
// run the read-only Ask sidecar (daemon/methods/answers.rs), so there is no
// second spawn path. A question card's Ask opens a thread here too (askAbout).
// Read marks live in the daemon, so a Got it survives a reload, a restart and
// the other device.
//
// The card owns its DOM inside the zone's fixed host (dashboard-zones.ts): a
// re-derive hands it new answers instead of replacing it, so an animation, an
// open Read more or a thread's message box is never wiped by a flush.

import { escapeHtml } from "../../../shared/escape-html";
import { localTime } from "../../../shared/formatters";
import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import { composerFieldHtml, wireComposerField, type ComposerFieldWiring } from "../../../shared/chat/composer-field";
import { openPalette, closePalette } from "../../command-palette/palette-ui";
import type { PaletteCommand } from "../../command-palette/types";
import type { AskThread } from "../../../types/ipc.generated";
import {
  historyGroups, isUnread, nextUnread, ownText, threadFollowUps, threadText, withoutSuggestion,
  type AnswerItem, type AnswerSide, type AnswerStore,
} from "../../../shared/chat/dashboard/answers-model";
import type { ZoneState } from "../../../shared/chat/dashboard/dashboard-model";
import type { QuestionAsk } from "../question-ask";
import { answersApi, cachedSide, emptySide, rememberSide } from "./answers-api";
import { cardHtml } from "./dashboard-zones";
import "./answers-card.css";

/** Thread keys of + questions that have no answer yet: `new:<n>`, one per
 *  question, so leaving one in flight and pressing + again starts a fresh one. */
const NEW_PREFIX = "new:";

/** The thread's tall size, shared by every chat's card and kept in memory only:
 *  Joe who grew one thread wants the next one tall too, and a reload resets it. */
let threadTall = false;
/** A tall thread is never shorter than the default one, and leaves the dashboard's padding. */
const TALL_MIN = 460;
const TALL_AIR = 24;
const isNew = (key: string | null): boolean => !!key && key.startsWith(NEW_PREFIX);

/** How long the card waits for the daemon's read marks before drawing anyway,
 *  so a slow daemon never leaves the zone blank. */
const LOAD_GRACE_MS = 400;
/** Only this many of the newest answers are given a model-written question; older rows keep their preview. */
const REWRITE_WINDOW = 5;
/** Rise: the text leaves in 200ms, then the next one rises in (board GOT_OUT_MS). */
const GOT_OUT_MS = 200;

export interface AnswersCardDeps {
  sessionId(): string | null;
  cwd(): string | null;
  /** The card's daemon data changed: the dashboard re-derives (a + answer may appear). */
  onSideChange(): void;
  /** The transcript's passes for freshly drawn markup (code, file refs, commit refs). */
  decorate(root: HTMLElement): void;
  /** Opens the question card a thread was asked from, minimized while Joe asked. */
  expandQuestion(): void;
}

const esc = escapeHtml;
const timeOf = (ms: number): string => (ms > 0 ? localTime(new Date(ms)) : "");
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

// The card's inner form of the real answer card: label, verdict, head, body,
// visuals. Cached per row object, which is replaced (never mutated) on change.
const innerCache = new WeakMap<object, string>();
function cardInner(item: AnswerItem): string {
  let html = innerCache.get(item.message);
  if (html === undefined) {
    const box = document.createElement("div");
    box.innerHTML = cardHtml(item.message);
    html = box.querySelector(".mc-full .mc-pad")?.innerHTML ?? "";
    innerCache.set(item.message, html);
  }
  return html;
}

// The shell renderMessageCard draws, so the tint, border and padding are the real ones.
const shell = (inner: string, cls = ""): string =>
  `<div class="msg assistant mc-root ax-shell ${cls}" data-card-kind="answer"><div class="mc-card mc-k-answer"><div class="mc-fold mc-full"><div class="mc-clip"><div class="mc-pad">${inner}</div></div></div></div></div>`;

const btn = (act: string, icon: string, label: string, tip: string, cls = "", extra = ""): string =>
  `<button type="button" class="ax-btn ${cls}" data-ax="${act}" title="${esc(tip)}"><i class="ph ${icon}"></i>${extra}<span class="ax-btn-t">${label}</span></button>`;

/** Ask replies carry no verdict; a reply that leads with one shows it bold. */
const bubble = (verdict: string, text: string): string =>
  `<div class="msg assistant ax-t-bub">${renderMarkdown(verdict ? `**${verdict}**\n\n${text}` : text, false)}</div>`;

export class AnswersCard {
  private host: HTMLElement | null = null;
  private items: AnswerItem[] = [];
  private side: AnswerSide = emptySide();
  private loadedFor: string | null = null;
  private loadingFor: string | null = null;
  /** The answer on the card; null = All caught up; undefined = not picked yet. */
  private cur: string | null | undefined = undefined;
  private open = false;
  /** The answer whose thread fills the card, or a `new:<n>` key for a + question with no answer yet. */
  private thread: string | null = null;
  private newSeq = 0;
  /** Question in flight per thread key. */
  private readonly pending = new Map<string, string>();
  private readonly errors = new Map<string, string>();
  /** A + question whose send failed, kept so the thread can still show what was asked. */
  private readonly failedAsk = new Map<string, string>();
  /** An unread answer that landed while Joe was in a thread: Back shows it. */
  private landedInThread: string | null = null;
  /** Threads asked from a question card, by thread key: the card's question,
   *  drawn at the top of the thread. A + key's entry moves to its answer's key
   *  once the reply lands. In memory: the rewritten question carries it after. */
  private readonly about = new Map<string, QuestionAsk>();
  /** The open thread came from a question card's Ask, so Back reopens that card. */
  private fromCard = false;
  /** Focus the thread's box once the zone draws it (the zone may not exist yet). */
  private focusOnDraw = false;
  /** Unsent text of a thread a question card's Ask switched away from, by key. */
  private readonly drafts = new Map<string, string>();
  private readonly seen = new Set<string>();
  /** Answers whose short question was asked for in this window, win or lose: a failed call is not retried until a reload. */
  private readonly rewriteTried = new Set<string>();
  private rewriteBusy = false;
  /** Joe has used the card since it loaded: a late load must not move it under him. */
  private touched = false;
  private anim = "";
  private gotBusy = false;
  private lastHtml = "";
  private wire: ComposerFieldWiring | null = null;
  private wiredFor: string | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Refits a tall thread when the dashboard's height changes. */
  private roomWatch: ResizeObserver | null = null;
  private readonly onClick = (e: MouseEvent): void => this.click(e);
  private readonly onFocus = (): void => this.refresh();

  constructor(private readonly deps: AnswersCardDeps) {
    if (typeof window !== "undefined") window.addEventListener("focus", this.onFocus);
  }

  /** What the dashboard's derive reads for the zone. */
  sideData(): AnswerSide {
    return this.side;
  }

  /** Called after every derive that draws the zone, with the zone's fixed host. */
  update(host: HTMLElement, state: ZoneState<"answers">): void {
    if (this.disposed) return;
    if (host !== this.host) {
      this.host?.removeEventListener("click", this.onClick);
      this.destroyWire();
      this.host = host;
      host.classList.add("ax-quiet-got", "ax-icon-acts");
      host.addEventListener("click", this.onClick);
      this.lastHtml = "";
      this.watchRoom(host);
    }
    this.items = state.items;
    this.ensureLoaded();
    if (!this.ready()) return;
    this.reconcile();
    this.render();
    if (this.focusOnDraw && this.wire) {
      this.focusOnDraw = false;
      this.focusInput();
    }
    this.pumpRewrites();
  }

  /** A thread is open: the dashboard draws the zone for it even with no answers. */
  threadOpen(): boolean {
    return this.thread !== null;
  }

  /** A question card's Ask: a thread about that question, Joe's first message the
   *  question. Asking about the same card again goes back to its thread. */
  askAbout(ask: QuestionAsk): void {
    if (this.disposed) return;
    this.touched = true;
    let key = [...this.about.entries()].find(([k, a]) => a.card === ask.card && (isNew(k) || this.item(k)))?.[0];
    if (!key) {
      key = `${NEW_PREFIX}${++this.newSeq}`;
      this.about.set(key, ask);
    }
    // Another thread's half-typed message waits for that thread to open again.
    const typed = this.wire?.textarea.value ?? "";
    if (this.wiredFor && this.wiredFor !== key && typed.trim()) this.drafts.set(this.wiredFor, typed);
    this.thread = key;
    this.fromCard = true;
    this.anim = "ax-t-slide-open";
    this.lastHtml = "";
    this.focusOnDraw = true;
    this.render();
    if (this.wire) {
      this.focusOnDraw = false;
      this.focusInput();
    }
    this.deps.onSideChange();
  }

  /** Has the daemon write the short question for the newest answers still showing a
   *  clipped preview, one call at a time (each is a model call on Joe's subscription).
   *  Only the newest few: older rows keep their preview rather than costing a call each. */
  private pumpRewrites(): void {
    const sid = this.deps.sessionId();
    if (!sid || this.rewriteBusy || this.disposed) return;
    const next = this.items.slice(-REWRITE_WINDOW).reverse().find((i) => i.provisional && !this.rewriteTried.has(i.key));
    if (!next) return;
    this.rewriteTried.add(next.key);
    this.rewriteBusy = true;
    const answer = [next.verdict, next.text].filter(Boolean).join("\n");
    answersApi().rewrite(sid, next.key, next.typed, answer)
      .then((store) => {
        if (this.disposed || this.deps.sessionId() !== sid) return;
        this.side = { store: mergeStore(store, this.side.store), threads: this.side.threads };
        rememberSide(sid, this.side);
        this.deps.onSideChange();
      })
      .catch((err) => console.warn("[answers-card] writing the short question failed; the preview stays", err))
      .finally(() => {
        this.rewriteBusy = false;
        this.pumpRewrites();
      });
  }

  /** The zone stopped drawing (no answers): forget the DOM, keep the state. */
  detach(): void {
    this.host?.removeEventListener("click", this.onClick);
    this.roomWatch?.disconnect();
    this.roomWatch = null;
    this.destroyWire();
    this.host = null;
    this.lastHtml = "";
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    if (typeof window !== "undefined") window.removeEventListener("focus", this.onFocus);
  }

  // ---- Data ------------------------------------------------------------------------

  private ready(): boolean {
    const sid = this.deps.sessionId();
    return !sid || this.loadedFor === sid;
  }

  private ensureLoaded(): void {
    const sid = this.deps.sessionId();
    if (!sid || this.loadedFor === sid || this.loadingFor === sid) return;
    if (this.loadedFor !== null) {
      // The window moved to another chat's id: nothing of the old chat carries over.
      this.cur = undefined;
      this.seen.clear();
      this.touched = false;
      this.side = emptySide();
      this.thread = null;
      this.landedInThread = null;
      this.about.clear();
      this.drafts.clear();
      this.fromCard = false;
      this.pending.clear();
      this.errors.clear();
      this.failedAsk.clear();
      this.rewriteTried.clear();
      this.rewriteBusy = false;
    }
    const cached = cachedSide(sid);
    if (cached) {
      this.side = cached;
      this.loadedFor = sid;
    }
    this.loadingFor = sid;
    if (!cached) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.loadingFor !== sid || this.disposed) return;
        this.loadedFor = sid;
        this.deps.onSideChange();
      }, LOAD_GRACE_MS);
    }
    answersApi().load(sid)
      .then((side) => {
        if (this.disposed || this.deps.sessionId() !== sid) return;
        // Merged, not replaced: a Got it or a thread reply may have landed while it loaded.
        this.side = { store: mergeStore(side.store, this.side.store), threads: mergeThreads(side.threads, this.side.threads) };
        rememberSide(sid, this.side);
        // A draw before the load used no read marks: pick again unless Joe acted.
        if (!this.touched) {
          this.cur = undefined;
          this.seen.clear();
        }
      })
      .catch((err) => console.warn("[answers-card] load failed; read marks stay in memory", err))
      .finally(() => {
        if (this.loadingFor !== sid || this.disposed) return;
        this.loadingFor = null;
        this.loadedFor = sid;
        if (this.graceTimer !== null) clearTimeout(this.graceTimer);
        this.graceTimer = null;
        this.deps.onSideChange();
      });
  }

  /** Another window (the pop-out, the other machine) may have read or replied. */
  private refresh(): void {
    const sid = this.deps.sessionId();
    if (!sid || this.loadedFor !== sid || this.loadingFor) return;
    answersApi().load(sid)
      .then((side) => {
        if (this.disposed || this.deps.sessionId() !== sid) return;
        this.side = { store: mergeStore(side.store, this.side.store), threads: mergeThreads(side.threads, this.side.threads) };
        rememberSide(sid, this.side);
        this.deps.onSideChange();
      })
      .catch(() => { /* the card keeps what it has */ });
  }

  private store(): AnswerStore {
    return this.side.store;
  }

  private item(key: string | null | undefined): AnswerItem | null {
    if (!key) return null;
    return this.items.find((i) => i.key === key) ?? null;
  }

  private unread(item: AnswerItem): boolean {
    return isUnread(item, this.store());
  }

  private markRead(keys: string[]): void {
    if (keys.length === 0) return;
    const now = Date.now();
    for (const k of keys) this.side.store.read[k] = now;
    const sid = this.deps.sessionId();
    if (sid) {
      rememberSide(sid, this.side);
      answersApi().mark(sid, keys, true).catch((err) => console.warn("[answers-card] marking read failed", err));
    }
  }

  private upsertThread(thread: AskThread, store: AnswerStore): void {
    const threads = [...this.side.threads];
    const i = threads.findIndex((t) => t.id === thread.id);
    if (i >= 0) threads[i] = thread;
    else threads.unshift(thread);
    this.side = { store: mergeStore(store, this.side.store), threads };
    const sid = this.deps.sessionId();
    if (sid) rememberSide(sid, this.side);
  }

  /** Picks the answer to show, and brings a newly landed unread one in. */
  private reconcile(): void {
    if (this.cur === undefined) {
      this.cur = nextUnread(this.items, this.store())?.key ?? null;
      for (const i of this.items) this.seen.add(i.key);
      return;
    }
    const fresh = this.items.filter((i) => !this.seen.has(i.key));
    for (const i of fresh) this.seen.add(i.key);
    const shown = this.item(this.cur);
    if (this.cur !== null && !shown) this.cur = nextUnread(this.items, this.store())?.key ?? null;
    if (this.thread && !isNew(this.thread) && !this.item(this.thread)) this.thread = null;
    const landed = fresh.filter((i) => this.unread(i)).at(-1);
    if (landed && this.thread !== null) this.landedInThread = landed.key;
    // The newest answer always takes the card, even over an older unread one,
    // which waits behind History's badge and the Next button. Only a thread holds
    // it back. An older answer surfacing late (an earlier history page) never
    // displaces the one on the card, and while Got it's text leaves, its own timer
    // picks the newest unread, which is this one.
    if (landed && this.thread === null && this.isNewerThanCur(landed) && !this.gotBusy) {
      this.cur = landed.key;
      this.anim = "ax-fade";
    }
  }

  private isNewerThanCur(item: AnswerItem): boolean {
    const cur = this.item(this.cur);
    return !cur || item.at >= cur.at;
  }

  // ---- Rendering -----------------------------------------------------------------------

  private otherUnread(): number {
    return this.items.filter((i) => i.key !== this.cur && this.unread(i)).length;
  }

  private historyBtn(): string {
    const u = this.otherUnread();
    const n = this.items.length;
    return `<button type="button" class="ax-icon${u ? " ax-ubadge" : ""}" data-ax="history" title="All ${plural(n, "answer")}${u ? `, ${u} more unread` : ""}: search them"><i class="ph ph-clock-counter-clockwise"></i>${u ? `<b>${u}</b>` : ""}</button>`;
  }

  private headerRow(): string {
    return `<div class="ax-head"><span class="mc-label ax-kind"><i class="ph ph-chat-circle-dots"></i>Answers</span><span class="ax-hq-gap"></span>`
      + `<span class="ax-icons">${this.historyBtn()}<button type="button" class="ax-icon" data-ax="new-q" title="New question"><i class="ph ph-plus"></i></button></span></div>`;
  }

  private checkBtn(item: AnswerItem): string {
    if (this.unread(item)) return btn("gotit", "ph-check", "Got it", "Got it: mark read and show the next unread", "ax-gotit");
    // Read (by Got it, or judged from Joe's reply): with others unread the
    // check becomes the way to the next one, so the card never moves by itself.
    const more = this.otherUnread();
    return more
      ? btn("close", "ph-arrow-down", "Next", `Read. Show the next unread (${more} more)`, "ax-next", `<b class="ax-btn-n">${more} more</b>`)
      : btn("close", "ph-check", "Read", "Read. Put it away", "ax-gotit ax-checked");
  }

  private replyBtn(item: AnswerItem): string {
    const n = item.replies;
    const busy = this.pending.has(item.key);
    // A follow-up that failed after Joe left the thread: the error is in the thread,
    // so the button says so instead of looking like nothing happened.
    const failed = !busy && this.errors.has(item.key);
    if (!n && !busy && !failed) return btn("reply", "ph-chats-circle", "Reply", "Reply: ask a follow-up in a thread");
    const tip = failed ? "Your follow-up failed. Open the thread to see why" : `Open the thread: ${plural(n, "back-and-forth")}${busy ? ", Claude is replying" : ""}`;
    return btn("reply", "ph-chats-circle", "Open thread", tip, `ax-thbtn${busy ? " ax-busy" : ""}${failed ? " ax-failed" : ""}`, n ? `<b class="ax-btn-n">${n}</b>` : "");
  }

  private readMoreLabel(): string {
    return this.open ? `Show less<i class="ph ph-caret-up"></i>` : `Read more<i class="ph ph-caret-down"></i>`;
  }

  private answerFace(item: AnswerItem): string {
    const raw = item.raw ? ` title="You wrote: ${esc(item.raw)}"` : "";
    const q = item.question ? `<div class="ax-qline"${raw}><time>${esc(timeOf(item.at))}</time><span>${esc(item.question)}</span></div>` : "";
    const rm = `<span class="ax-readmore ax-rm-bottom-right" data-ax="toggle">${this.readMoreLabel()}</span>`;
    return `<div class="ax-face ax-pos-bottom-left ax-align-center has-more${this.open ? " open" : ""}" data-ans="${esc(item.key)}">`
      + `<div class="ax-mid"><div class="ax-tb"><div class="ax-row"><div class="ax-text" data-ax="toggle">${q}${cardInner(item)}</div></div></div></div>`
      + `<div class="ax-actions ax-actions--bottom-left">${this.checkBtn(item)}${this.replyBtn(item)}${rm}</div></div>`;
  }

  private caughtFace(): string {
    return `<div class="ax-cc"><span class="ax-cc-t"><i class="ph ph-checks"></i>All caught up</span>`
      + `<span class="ax-cc-b"><button type="button" class="ax-tbtn" data-ax="history"><i class="ph ph-clock-counter-clockwise"></i>History</button>`
      + `<button type="button" class="ax-tbtn" data-ax="new-q"><i class="ph ph-plus"></i>New question</button></span></div>`;
  }

  private threadFace(): string {
    const fresh = isNew(this.thread);
    const item = fresh ? null : this.item(this.thread);
    const card = fresh ? this.about.get(this.thread!) : undefined;
    const title = card
      ? card.title
      : fresh ? (this.pending.get(this.thread!) ?? this.failedAsk.get(this.thread!) ?? "Ask anything; your first message is the question") : item?.question || item?.verdict || "";
    const sub = item?.verdict ? `<span class="ax-thead-s">${esc(item.verdict)}</span>` : "";
    const kind = card ? "About a question" : fresh ? "New question" : "Thread";
    const back = this.fromCard ? "Back to the question" : "Back to the answer";
    const placeholder = card ? "Ask about this question..." : fresh ? "Ask Claude a question..." : "Follow up on this answer...";
    return `<div class="ax-thread"><div class="ax-thead"><button type="button" class="ax-back" data-ax="close-thread" title="${back}"><i class="ph ph-arrow-left"></i></button>`
      + `<div class="ax-thead-t"><span class="ax-thead-k">${kind}</span><span class="ax-thead-v" title="${esc(title)}">${esc(title)}</span>${sub}</div>`
      + `<button type="button" class="ax-back ax-grow" data-ax="grow-thread" title="Taller thread (fills the window)"><i class="ph ph-arrows-out-simple"></i><i class="ph ph-arrows-in-simple"></i></button></div>`
      + `<div class="ax-tbody"></div>`
      + `<div class="ax-tcomp">${composerFieldHtml({ placeholder, inputClass: "ax-t-input", sendClass: "ax-t-send" })}</div></div>`;
  }

  private threadBodyHtml(): string {
    const key = this.thread!;
    const item = isNew(key) ? null : this.item(key);
    const parts: string[] = [];
    // A thread asked from a question card opens on that question and its options.
    const card = this.about.get(key);
    if (card) parts.push(`<div class="msg assistant ax-t-bub ax-about">${renderMarkdown(card.about, false)}</div>`);
    if (item) {
      // Every thread opens on the question and the answer it got; they are not a back-and-forth.
      const raw = item.raw ? `<span class="ax-q0-raw">You wrote: ${esc(item.raw)}</span>` : "";
      if (item.question) parts.push(`<div class="msg user ax-q ax-q0">${renderMarkdown(item.question, true)}${raw}</div>`);
      parts.push(bubble(item.verdict, item.text));
      for (const m of threadFollowUps(item)) {
        parts.push(m.role === "user"
          ? `<div class="msg user ax-q">${renderMarkdown(m.text, true)}</div>`
          : bubble("", withoutSuggestion(m.text)));
      }
    }
    const failedQ = this.failedAsk.get(key);
    if (failedQ) parts.push(`<div class="msg user ax-q">${renderMarkdown(failedQ, true)}</div>`);
    const asking = this.pending.get(key);
    if (asking) parts.push(`<div class="msg user ax-q">${renderMarkdown(asking, true)}</div>`, `<div class="ax-thinking"><span class="ax-spin"></span>reading...</div>`);
    const err = this.errors.get(key);
    if (err) parts.push(`<div class="ax-error">${esc(err)}</div>`);
    if (!parts.length) {
      return `<div class="ax-empty"><i class="ph ph-chat-teardrop-dots"></i><span>Ask anything. Your first message is the question; Claude's reply lands in Answers.</span></div>`;
    }
    return parts.join("");
  }

  private destroyWire(): void {
    this.wire?.destroy();
    this.wire = null;
    this.wiredFor = null;
  }

  private render(): void {
    const host = this.host;
    // While Got it's text leaves, a flush must not redraw it back; the timer draws next.
    if (!host || !this.ready() || this.gotBusy) return;
    const anim = this.anim;
    this.anim = "";
    if (this.thread !== null) {
      // Picks up a Grow done in another chat's card since this one last drew.
      if (host.classList.contains("ax-th-tall") !== threadTall) this.fitTall();
      this.renderThread(host, anim);
      return;
    }
    this.destroyWire();
    const item = this.item(this.cur);
    const html = item
      ? shell(`${this.headerRow()}<div class="ax-in">${this.answerFace(item)}</div>`)
      : shell(`<div class="ax-in">${this.caughtFace()}</div>`, "ax-caughtmode ax-frame-border ax-cu-both");
    // The HTML is compared without its animation class, so a flush that lands
    // mid-animation finds nothing changed and lets the motion finish.
    if (html === this.lastHtml && !anim) return;
    this.lastHtml = html;
    host.innerHTML = html;
    this.applyAnim(host, anim);
    this.deps.decorate(host);
  }

  private renderThread(host: HTMLElement, anim: string): void {
    const key = this.thread!;
    const frame = shell(`<div class="ax-in">${this.threadFace()}</div>`, "ax-threadmode");
    if (frame !== this.lastHtml || this.wiredFor !== key) {
      const kept = this.drafts.get(key) ?? "";
      this.drafts.delete(key);
      const draft = this.wiredFor === key ? this.wire?.textarea.value ?? "" : kept;
      const hadFocus = !!this.wire && document.activeElement === this.wire.textarea;
      this.destroyWire();
      this.lastHtml = frame;
      host.innerHTML = frame;
      const row = host.querySelector<HTMLElement>(".ax-tcomp .composer-field");
      if (row) {
        this.wire = wireComposerField(row, {
          onSend: (text) => this.sendInThread(text),
          canSend: () => !this.pending.has(this.thread ?? ""),
        });
        this.wiredFor = key;
        if (draft && this.wire) {
          this.wire.textarea.value = draft;
          this.wire.core.handleInput();
        }
        if (hadFocus) this.wire?.textarea.focus({ preventScroll: true });
      }
      this.applyAnim(host, anim);
    }
    const body = host.querySelector<HTMLElement>(".ax-tbody");
    if (body) {
      const html = this.threadBodyHtml();
      // Only new content scrolls to the bottom, so a flush never yanks Joe back while he reads up.
      if (body.dataset.html !== html) {
        body.dataset.html = html;
        body.innerHTML = html;
        this.deps.decorate(body);
        body.scrollTop = body.scrollHeight;
      }
    }
    this.wire?.sync();
  }

  /** "mid:" animates only the answer's text block, so the header and the buttons stay still. */
  private applyAnim(host: HTMLElement, anim: string): void {
    if (!anim) return;
    const mid = anim.startsWith("mid:");
    const target = host.querySelector(mid ? ".ax-mid" : ".ax-in");
    target?.classList.add(mid ? anim.slice(4) : anim);
    // While anything moves the card clips instead of scrolling, so no scrollbar flashes on its edge.
    const sh = host.querySelector<HTMLElement>(".ax-shell");
    sh?.classList.add("ax-animating");
    setTimeout(() => sh?.classList.remove("ax-animating"), 700);
  }

  // ---- Actions -------------------------------------------------------------------------

  private click(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-ax]")?.dataset.ax;
    const selecting = !!window.getSelection?.()?.toString();
    switch (act) {
      case "gotit": return this.gotIt();
      case "close": return this.putAway();
      case "reply": return this.openThread();
      case "new-q": return this.newQuestion();
      case "close-thread": return this.closeThread();
      case "grow-thread": return this.growThread();
      case "history": return this.history();
      case "toggle":
        if (t.closest("a, button, .attachment-chip, [data-file-ref]") && !t.closest(".ax-readmore")) return;
        if (!selecting) this.toggleOpen();
        return;
    }
    // Anywhere on the answer that is not a control opens or folds it, the header included.
    if (this.thread === null && this.host?.querySelector(".ax-face") && t.closest(".ax-shell")
      && !t.closest("a, button, input, textarea, .attachment-chip, [role='button']") && !selecting) {
      this.toggleOpen();
    }
  }

  /** Opens and folds in place: each part grows its own height and fades in through
   *  CSS, so no re-render and nothing flickers. An open card stays open across Got it. */
  private toggleOpen(): void {
    const host = this.host;
    const face = host?.querySelector<HTMLElement>(".ax-face");
    if (!host || !face) return;
    this.touched = true;
    this.open = !this.open;
    face.classList.toggle("open", this.open);
    const rm = face.querySelector(".ax-readmore");
    if (rm) rm.innerHTML = this.readMoreLabel();
    const item = this.item(this.cur);
    if (item) this.lastHtml = shell(`${this.headerRow()}<div class="ax-in">${this.answerFace(item)}</div>`);
    const sh = host.querySelector<HTMLElement>(".ax-shell");
    sh?.classList.add("ax-animating");
    setTimeout(() => sh?.classList.remove("ax-animating"), 450);
  }

  private gotIt(): void {
    const item = this.item(this.cur);
    if (!item || !this.unread(item) || this.gotBusy) return;
    this.touched = true;
    this.markRead([item.key]);
    this.gotBusy = true;
    // Only the answer's text leaves and arrives; the header and the buttons stay put.
    this.host?.querySelector(".ax-mid")?.classList.add("ax-g-rise-out");
    setTimeout(() => {
      this.gotBusy = false;
      if (this.disposed) return;
      // Walk back: the next newest unread comes in; with none left, All caught up fades in.
      const next = nextUnread(this.items, this.store());
      this.cur = next?.key ?? null;
      this.anim = next ? "mid:ax-g-rise-in" : "ax-c-fade";
      this.lastHtml = "";
      this.render();
    }, GOT_OUT_MS);
  }

  /** The grey check on a read answer puts it away: the next unread, or All caught up. */
  private putAway(): void {
    this.touched = true;
    this.cur = nextUnread(this.items, this.store())?.key ?? null;
    this.anim = "ax-fade";
    this.render();
  }

  private show(key: string): void {
    closePalette();
    this.touched = true;
    this.thread = null;
    this.cur = key;
    this.anim = "mid:ax-g-rise-in";
    this.lastHtml = "";
    this.render();
  }

  private openThread(): void {
    const item = this.item(this.cur);
    if (!item || this.thread !== null) return;
    this.touched = true;
    this.fromCard = false;
    this.thread = item.key;
    this.anim = "ax-t-slide-open";
    this.render();
    this.focusInput();
  }

  private newQuestion(): void {
    if (this.thread !== null) return;
    this.touched = true;
    this.fromCard = false;
    // A + question whose send failed after Joe left it reopens, with its error,
    // so it never vanishes silently; otherwise + starts a fresh one. A question
    // card's failed ask stays with that card's Ask.
    const failed = [...this.failedAsk.keys()].filter((k) => !this.about.has(k)).at(-1);
    this.thread = failed ?? `${NEW_PREFIX}${++this.newSeq}`;
    this.anim = "ax-t-slide-open";
    this.render();
    this.focusInput();
  }

  /** Set on the zone's own host, so the thread grows without a re-render and its
   *  message box (and anything typed in it) stays put. */
  private growThread(): void {
    // From what this card shows, not the shared flag, which another chat may have flipped since.
    threadTall = !this.host?.classList.contains("ax-th-tall");
    this.fitTall();
    if (threadTall) this.host?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /** Tall = the dashboard's visible height, so the message box stays on screen;
   *  the window's height would push it under the chat's own composer. */
  private fitTall(): void {
    const host = this.host;
    if (!host) return;
    host.classList.toggle("ax-th-tall", threadTall);
    const room = host.closest<HTMLElement>(".cdash-body")?.clientHeight ?? 0;
    if (threadTall && room) host.style.setProperty("--ax-th", `${Math.max(TALL_MIN, room - TALL_AIR)}px`);
    else host.style.removeProperty("--ax-th");
  }

  private watchRoom(host: HTMLElement): void {
    this.roomWatch?.disconnect();
    this.roomWatch = null;
    const body = host.closest<HTMLElement>(".cdash-body");
    if (body && typeof ResizeObserver !== "undefined") {
      this.roomWatch = new ResizeObserver(() => this.fitTall());
      this.roomWatch.observe(body);
    }
    this.fitTall();
  }

  private closeThread(): void {
    // An error has now been seen: a failed + question lets the next + start fresh,
    // and a failed follow-up stops marking its thread button.
    if (this.thread) {
      this.failedAsk.delete(this.thread);
      this.errors.delete(this.thread);
    }
    const reopenCard = this.fromCard;
    this.fromCard = false;
    this.thread = null;
    this.anim = "ax-t-slide-close";
    // Back returns to the answer Joe was on, unless a newer one landed while he
    // was in the thread: the newest always takes the card.
    const curItem = this.item(this.cur);
    const landed = this.item(this.landedInThread);
    this.landedInThread = null;
    if (landed && this.unread(landed) && this.isNewerThanCur(landed)) this.cur = landed.key;
    else if (!curItem) this.cur = nextUnread(this.items, this.store())?.key ?? null;
    this.lastHtml = "";
    this.render();
    // The card was minimized for the thread; leaving it brings the card back.
    if (reopenCard) this.deps.expandQuestion();
    // A thread that was the zone's only reason to draw is gone.
    if (this.items.length === 0) this.deps.onSideChange();
  }

  private focusInput(): void {
    this.wire?.textarea.focus({ preventScroll: true });
  }

  private sendInThread(text: string): void {
    const key = this.thread;
    const sid = this.deps.sessionId();
    const q = text.trim();
    if (!key || !sid || !q || this.pending.has(key)) return;
    this.wire?.clear();
    this.errors.delete(key);
    this.failedAsk.delete(key);
    this.pending.set(key, q);
    const item = isNew(key) ? null : this.item(key);
    const wasRead = item ? !this.unread(item) : false;
    const card = isNew(key) ? this.about.get(key) : undefined;
    this.render();
    void answersApi().send({
      sessionId: sid,
      key: isNew(key) ? null : key,
      question: q,
      cwd: this.deps.cwd(),
      // On a new thread this is the question card it was asked from; a clipped preview
      // would tell the Ask sidecar a truncated question.
      aboutQuestion: card?.about ?? (item?.provisional ? item.typed : item?.question),
      aboutAnswer: item ? [item.verdict, item.text].filter(Boolean).join("\n") : undefined,
    })
      .then(({ thread, state }) => {
        if (this.disposed || this.deps.sessionId() !== sid) return;
        this.pending.delete(key);
        this.upsertThread(thread, state);
        if (isNew(key)) {
          const answerKey = `ask:${thread.id}`;
          // Still in the thread: it becomes this answer's thread, and the answer
          // waits unread for Back. Left already: it lands like any new answer.
          if (card) {
            this.about.delete(key);
            this.about.set(answerKey, card);
          }
          // A follow-up typed while it was pending, kept when Ask switched away, follows the thread.
          const kept = this.drafts.get(key);
          if (kept !== undefined) {
            this.drafts.delete(key);
            this.drafts.set(answerKey, kept);
          }
          if (this.thread === key) {
            // The thread keeps its message box (and any follow-up being typed) across the key change.
            if (this.wiredFor === key) this.wiredFor = answerKey;
            this.thread = answerKey;
            this.cur = answerKey;
            this.seen.add(answerKey);
          }
        } else if (this.thread === key && wasRead) {
          // Read while Joe watched it arrive: it stays read.
          this.markRead([key]);
        } else if (this.thread === null && !this.gotBusy) {
          // A reply after leaving the thread makes the answer unread again, and
          // like any newer answer it takes the card.
          this.cur = key;
          this.anim = "ax-fade";
          this.lastHtml = "";
        }
        this.deps.onSideChange();
      })
      .catch((err) => {
        if (this.disposed) return;
        this.pending.delete(key);
        this.errors.set(key, String((err as { message?: string })?.message ?? err));
        if (isNew(key)) this.failedAsk.set(key, q);
        this.render();
      });
  }

  // ---- History -------------------------------------------------------------------------

  private markAllRead(): void {
    const keys = this.items.filter((i) => this.unread(i)).map((i) => i.key);
    this.touched = true;
    this.markRead(keys);
    this.cur = null;
    this.thread = null;
    this.anim = "ax-c-fade";
    this.lastHtml = "";
    this.render();
  }

  /** One command-palette list: Mark all N as read, then Unread / Read with a
   *  thread / Read, newest first. Rows show the question; search covers threads. */
  private history(): void {
    const store = this.store();
    const { groups, headings } = historyGroups(this.items, store);
    const byId = new Map<string, AnswerItem>();
    const groupOf = new Map<string, string>();
    const rows: PaletteCommand[] = [];
    const unread = this.items.filter((i) => isUnread(i, store)).length;
    if (unread) rows.push({ id: "answers-mark-all", title: `Mark all ${unread} as read`, icon: "checks", group: "", run: () => this.markAllRead() });
    for (const g of groups) {
      for (const it of g.items) {
        const id = `answer:${it.key}`;
        byId.set(id, it);
        groupOf.set(id, g.label);
        rows.push({
          id,
          title: it.question || it.verdict,
          icon: g.id === "unread" ? "circle-wavy" : "check",
          group: timeOf(it.at),
          // Thread text rides keywords, which the ranker scores below a hit in the
          // title, so a hit in the question always outranks one found only in a thread.
          keywords: [it.verdict, it.raw ?? "", it.text, threadText(it)],
          run: () => this.show(it.key),
        });
      }
    }
    openPalette({
      sync: () => rows,
      later: [],
      remember: false,
      placeholder: `Search ${plural(this.items.length, "answer")} and their threads`,
      // The ranker's fuzzy tier matches scattered letters ("toast" in "tracker or
      // start"), which is noise when looking for one answer: only literal hits stay.
      match: (c, query) => {
        const it = byId.get(c.id);
        if (!it) return true;
        const q = query.toLowerCase();
        return ownText(it).toLowerCase().includes(q) || threadText(it).toLowerCase().includes(q);
      },
      decorate: (list, shown, query) => decorateHistory(list, shown, query, byId, groupOf, headings),
    });
  }
}

/** How long a thread the daemon's list lacks is kept: long enough for a load
 *  that started before its reply was saved, short enough that a thread gone
 *  from the daemon's store leaves the card. */
const LOCAL_THREAD_GRACE_MS = 60_000;

/** The newer copy of each thread wins (a reply only ever adds messages). */
function mergeThreads(server: readonly AskThread[], local: readonly AskThread[]): AskThread[] {
  const out = [...server];
  const now = Date.now();
  for (const t of local) {
    const i = out.findIndex((x) => x.id === t.id);
    if (i < 0) {
      if (now - Number(t.updated_at) < LOCAL_THREAD_GRACE_MS) out.push(t);
    } else if (t.messages.length > out[i]!.messages.length) out[i] = t;
  }
  return out;
}

/** Read marks only ever move forward, so a reply's state never undoes a Got it still in flight. */
function mergeStore(server: AnswerStore, local: AnswerStore): AnswerStore {
  const read = { ...server.read };
  for (const [k, v] of Object.entries(local.read)) if ((read[k] ?? -1) < v) read[k] = v;
  return {
    read,
    threads: { ...local.threads, ...server.threads },
    questions: server.questions.length >= local.questions.length ? server.questions : local.questions,
    rewrites: { ...local.rewrites, ...server.rewrites },
  };
}

function decorateHistory(
  list: HTMLElement,
  shown: readonly PaletteCommand[],
  query: string,
  byId: ReadonlyMap<string, AnswerItem>,
  groupOf: ReadonlyMap<string, string>,
  headings: boolean,
): void {
  const q = query.trim().toLowerCase();
  let prev = "";
  list.querySelectorAll<HTMLElement>(".cp-row").forEach((row) => {
    const c = shown[Number(row.dataset.index)];
    const it = c ? byId.get(c.id) : undefined;
    if (!c || !it) return;
    // A row whose answer has a thread says so: a small chat icon and its count.
    if (it.replies > 0) {
      row.querySelector(".cp-spacer")?.insertAdjacentHTML("beforebegin",
        `<span class="ax-cp-th" title="Has a thread: ${plural(it.replies, "back-and-forth")}"><i class="ph ph-chats-circle"></i>${it.replies}</span>`);
    }
    // A row found only through its thread says so, with the words that matched.
    if (q && !ownText(it).toLowerCase().includes(q)) {
      const hit = threadFollowUps(it).map((m) => m.text).find((t) => t.toLowerCase().includes(q));
      if (hit) {
        const at = hit.toLowerCase().indexOf(q);
        const from = Math.max(0, at - 24);
        const end = at + q.length + 30;
        const snip = (from ? "..." : "") + hit.slice(from, end).replace(/\n/g, " ") + (end < hit.length ? "..." : "");
        row.querySelector(".cp-title")?.insertAdjacentHTML("afterend",
          `<span class="cp-detail"><span class="ax-cp-tag"><i class="ph ph-chats-circle"></i>in thread</span><span class="ax-cp-snip">${esc(snip)}</span></span>`);
      }
    }
    // A heading opens each group, only while the list is in its own order and holds two groups or more.
    const g = groupOf.get(c.id) ?? "";
    if (headings && !q && g !== prev) row.insertAdjacentHTML("beforebegin", `<div class="cp-section ax-sec">${esc(g)}</div>`);
    prev = g;
  });
}
