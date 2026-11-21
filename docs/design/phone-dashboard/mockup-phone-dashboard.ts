// Scratch board: the chat dashboard on a phone, three layouts and one redone header. Never shipped.
// Real: the dashboard model (deriveDashboard over a real ChatRenderer fed events), every zone
// renderer (renderZone), the Answers card (AnswersCard), the Subchats card (SubsCard), the Done
// card, the real strip, and the real SessionHeader for the Today stage. Only `.pd-*` pieces are
// proposal markup: the new header, the stage frame, the tab strip (B), the folds (C).
import "./mockup-phone-dashboard-shim";
import "./mockup-phone-dashboard-phosphor.css";
import "../../vendor/tauri_kit/frontend/styleguide/themes/theme-void.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/inputs.css";
import "../../src/styles/toggle-switch.css";
import "../../src/shared/chat/chat.css";
import "../../src/views/sessions/sessions.css";
import "../../src/views/sessions/session-header.css";
import "../../src/views/sessions/sessions-mobile.css";
import "../../src/views/sessions/sidebar-ring.css";
import "../../src/views/sessions/session-statusbar.css";
import "../../src/views/sessions/effort-battery.css";
import "../../src/views/sessions/session-avatar.css";
import "../../src/views/sessions/chat-dashboard/chat-dashboard.css";
import "../../src/views/sessions/chat-dashboard/dashboard-extras.css";
import "../../src/views/sessions/chat-dashboard/subs-card.css";
import baseRaw from "../../src/styles/base.css?raw";
import sessionsRaw from "../../src/views/sessions/sessions.css?raw";
import headerRaw from "../../src/views/sessions/session-header.css?raw";
import mobileRaw from "../../src/views/sessions/sessions-mobile.css?raw";
import dashRaw from "../../src/views/sessions/chat-dashboard/chat-dashboard.css?raw";
import extrasRaw from "../../src/views/sessions/chat-dashboard/dashboard-extras.css?raw";
import doneRaw from "../../src/views/sessions/chat-dashboard/done-card.css?raw";
import answersRaw from "../../src/views/sessions/chat-dashboard/answers-card.css?raw";
import subsRaw from "../../src/views/sessions/chat-dashboard/subs-card.css?raw";
import { ChatRenderer } from "../../src/shared/chat/chat-renderer";
import { deriveDashboard, type DashboardState, type DrawnZone, type ZoneId, attachTabOf } from "../../src/shared/chat/dashboard/dashboard-model";
import { renderStrip, renderZone, initialUi, cardHtml, type DashUi, type ZoneCtx } from "../../src/views/sessions/chat-dashboard/dashboard-zones";
import { fillAgo } from "../../src/views/sessions/chat-dashboard/done-card";
import { AnswersCard } from "../../src/views/sessions/chat-dashboard/answers-card";
import { setAnswersApi } from "../../src/views/sessions/chat-dashboard/answers-api";
import { SubsCard } from "../../src/views/sessions/chat-dashboard/subs-card";
import { countSubs, subCountsText, type SubCardItem } from "../../src/shared/chat/dashboard/subs-model";
import { subCardRow, SUBCARD_TOOL } from "../../src/shared/chat/subchat-cards";
import { emptyStore } from "../../src/shared/chat/dashboard/answers-model";
import { ringHtml, type RingSpec } from "../../src/views/sessions/sidebar-ring";
import { SessionHeader } from "../../src/views/sessions/session-header";

// ---- Phone-mode css ---------------------------------------------------------------------------
// The app's phone rules hang on viewport media queries, and this board sits in a wide panel, so a
// 390px stage alone would draw the desktop branch. Every width-conditional @media block of the real
// stylesheets is copied here with its condition made always-true (max-width >= 390) or always-false
// (min-width > 390), which is what a 390px viewport evaluates. Nothing else in the css is changed.
function widthMediaBlocks(css: string): string {
  const out: string[] = [];
  const re = /@media\s*([^{]*?)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    if (!/(max|min)-width/.test(m[1]!)) continue;
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      const c = css[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const cond = m[1]!
      .replace(/\(\s*max-width:\s*([\d.]+)px\s*\)/g, (_s, n) => (Number(n) >= 390 ? "(min-width: 0px)" : "(max-width: 0px)"))
      .replace(/\(\s*min-width:\s*([\d.]+)px\s*\)/g, (_s, n) => (Number(n) <= 390 ? "(min-width: 0px)" : "(max-width: 0px)"));
    out.push(`@media ${cond}{${css.slice(re.lastIndex, i - 1)}}`);
    re.lastIndex = i;
  }
  return out.join("\n");
}
const phoneCss = [baseRaw, sessionsRaw, headerRaw, mobileRaw, dashRaw, extrasRaw, doneRaw, answersRaw, subsRaw].map(widthMediaBlocks).join("\n");
const phoneStyle = document.createElement("style");
phoneStyle.id = "pd-phone-css";
phoneStyle.textContent = phoneCss;
document.head.appendChild(phoneStyle);

// ---- Fixture: a busy main chat ----------------------------------------------------------------

const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const STATUS = "mcp__cc_conductor__report_turn_status";
const NOW = Date.now();
const ago = (min: number) => NOW - min * 60_000;
let seq = 0;
const ok = (id: string) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{}" }, is_error: false, timestamp: 0 });
const user = (text: string, ts: number) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: ts });
const tool = (name: string, input: unknown, ts: number) => {
  const id = `t${++seq}`;
  return [{ type: "tool_use", tool_name: name, input, id, timestamp: ts }, { ...ok(id), timestamp: ts }];
};

const renderer = new ChatRenderer(document.createElement("div"));
const feed = (events: unknown[]) => { for (const ev of events) renderer.handleEvent(ev as never); };
feed([
  user("Put the dashboard on the phone for main chats and redo the phone header. Mock it three ways first.", ago(190)),
  ...tool(PLAN, { steps: [
    { text: "Read the desktop zones", status: "done", detail: "ZONES in dashboard-model.ts" },
    { text: "Mock three phone layouts", status: "done" },
    { text: "Redo the phone header", status: "active" },
    { text: "Wire the dashboard into the phone page", status: "pending" },
    { text: "Phone-width view specs", status: "pending" },
  ] }, ago(188)),
  user("does the phone get the same cards as desktop?", ago(150)),
  ...tool(SEND, { kind: "answer", verdict: "Yes, same cards", tone: "good", question: "does the phone get the same cards as desktop?", text: "The phone draws the same zone renderers.\nOnly the columns stack instead of sitting side by side." }, ago(149)),
  user("and does the Answers card keep its threads when the phone swipes between columns, and where do the chat heads go on such a narrow screen?", ago(120)),
  ...tool(SEND, { kind: "answer", verdict: "Threads stay", tone: "good", question: "and does the Answers card keep its threads when the phone swipes between columns, and where do the chat heads go on such a narrow screen?", text: "The card owns its own DOM, so a re-derive never wipes a thread." }, ago(119)),
  ...tool(SEND, { kind: "report", verdict: "Three layouts mocked, header redone", text: "Branch https://github.com/SirBepy/claude-conductor/pull/418 holds the mock. The plan is in .claude/todos/PLAN.md and the zones live in src/views/sessions/chat-dashboard/dashboard-zones.ts.\nTracked as https://app.shortcut.com/sirbepy/story/56802.", done: ["Stacked column, swipe pages and folding cards drawn", "New one-row header with a Messages/Dashboard switch"], not_done: ["Phone page does not mount the dashboard yet"], your_move: ["Pick a layout"] }, ago(100)),
  ...tool(STATUS, { status: "done" }, ago(99)),
  ...tool(SEND, { kind: "blocker", verdict: "Needs the Trello token", tone: "warn", text: "The board id check cannot run without it.\nAdd TRELLO_API_KEY and TRELLO_TOKEN in the key modal." }, ago(40)),
  ...tool(SEND, { kind: "do_this", verdict: "Pick the header", tone: "warn", text: "Which header do you want on the phone?\nThe board shows one proposal under every layout." }, ago(12)),
]);

const HOVER = (word: string, n: number, text: string, action: string) => ({
  stateWord: word, step: { n, total: 6, text }, plan: null, action: { text: action, at: ago(1) }, queue: null, resetsAt: null, gaming: false,
});
const sub = (id: string, name: string, over: Partial<SubCardItem> = {}): SubCardItem => ({
  id, name, kind: "working", closing: false, model: "claude-sonnet-4-6", effort: "high", progress: "step 3 of 6",
  startedAt: new Date(ago(95)).toISOString(), finishedAt: null, ring: { kind: "solid", tone: "working", glow: true } as RingSpec,
  hover: HOVER("Working", 3, "Wire the footer", "Editing footer.css"), ...over,
});
const subs: SubCardItem[] = [
  sub("s1", "pc-1810-phone-header"),
  sub("s2", "pc-1811-trello-board-check", { kind: "asking", progress: "needs your input", ring: { kind: "solid", tone: "attention", pulse: true }, hover: HOVER("Asking", 4, "Pick where the keys live", "Waiting on you") }),
  sub("s3", "pc-1812-android-shell", { kind: "limited", progress: "usage limit", ring: { kind: "solid", tone: "dim" } as RingSpec, hover: { ...HOVER("Usage limit", 2, "Build the apk", "Building"), resetsAt: NOW + 50 * 60_000 } }),
  sub("s4", "pc-1805-attachments-card", { kind: "finished", progress: "finished", startedAt: new Date(ago(300)).toISOString(), finishedAt: ago(140), ring: { kind: "none" }, model: "claude-opus-4-8", effort: "xhigh" }),
  sub("s5", "pc-1805-attachments-review", { kind: "finished", progress: "finished", startedAt: new Date(ago(260)).toISOString(), finishedAt: ago(110), ring: { kind: "none" } }),
  sub("s6", "pc-1807-done-left-layout", { kind: "finished", progress: "finished", startedAt: new Date(ago(200)).toISOString(), finishedAt: ago(70), ring: { kind: "none" } }),
  sub("s7", "dashboard-footer-fix", { kind: "finished", progress: "finished", startedAt: new Date(ago(180)).toISOString(), finishedAt: ago(30), ring: { kind: "none" } }),
];
const finishEntry = (subId: string, name: string, ts: number, verdict: string, text: string) => subCardRow({
  tool_name: SUBCARD_TOOL,
  input: { id: `card-${subId}`, ts, parent_id: "main", kind: "finish", sub_id: subId, sub_name: name, round: 1, model: "sonnet", effort: "high", verdict, tone: "good", text, points: [], done: ["Built it"], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null },
});
const subRows = [
  finishEntry("s4", "pc-1805-attachments-card", ago(140), "Four tabs built", "Links, Files, Previews and Images."),
  finishEntry("s5", "pc-1805-attachments-review", ago(110), "pc-1805: review fixes in", "Two fixes landed."),
  finishEntry("s6", "pc-1807-done-left-layout", ago(70), "Done card moves left", "The junction row stays."),
  finishEntry("s7", "dashboard-footer-fix", ago(30), "Footer clipped no more", "One css line."),
].filter(Boolean);

const messages = [...renderer.messages, ...subRows] as never[];
const dash: DashboardState = deriveDashboard({ messages, plans: renderer.dashPlans, subs, now: NOW, sessionId: null } as never);
setAnswersApi({
  load: async () => ({ store: emptyStore(), threads: [] }),
  mark: async () => emptyStore(),
  rewrite: async () => emptyStore(),
  send: async () => { throw new Error("board"); },
} as never);

// ---- Round 2: three swipe columns (Chat | Needs you | Progress) --------------------------------------
import { plainUserText } from "../../src/views/sessions/chat-dashboard/dashboard-zones";
import { rowMs } from "../../src/shared/chat/dashboard/dashboard-model";

const waitingCount = (dash.left.find((z) => z.id === "waiting")?.state as { items: unknown[] } | undefined)?.items.length ?? 0;
const subCounts = countSubs(subs)!;
const PROJECT = "Conductor";
const monogram = `<span class="session-header-project-face"><span class="proj-face is-monogram">CO</span></span>`;

// ---- The latest-message card (the strip) ----------------------------------------------------------

const stripMsgs = dash.strip?.messages ?? [];
const clock = (m: unknown): string => new Date(rowMs(m as never)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
type StripVariant = "line" | "clamp" | "chip" | "corner";

/** Animates a height change of `el` around `change()`, so an expand never snaps. */
function animateHeight(el: HTMLElement, change: () => void): void {
  const h0 = el.offsetHeight;
  change();
  const h1 = el.offsetHeight;
  if (h0 === h1) return;
  el.style.height = `${h0}px`;
  el.style.overflow = "hidden";
  void el.offsetHeight;
  el.style.transition = "height .22s cubic-bezier(0.22, 1, 0.36, 1)";
  el.style.height = `${h1}px`;
  const done = (): void => { el.style.height = ""; el.style.overflow = ""; el.style.transition = ""; el.removeEventListener("transitionend", done); };
  el.addEventListener("transitionend", done);
  window.setTimeout(done, 400);
}

/** One strip card. No "You" label, no time at rest; a tap on the text opens it (time plus full
 *  text), and the icon alone (no count) opens the earlier messages. */
function stripCard(variant: StripVariant): HTMLElement {
  let idx = stripMsgs.length - 1;
  const box = document.createElement("div");
  box.className = `cdash-strip pd-s pd-s--${variant}`;
  const draw = (): void => {
    const m = stripMsgs[idx]!;
    box.querySelector<HTMLElement>(".pd-sm-t")!.textContent = plainUserText(m);
    box.querySelector<HTMLElement>(".pd-sm-time")!.textContent = clock(m);
  };
  const earlier = stripMsgs.slice(0, -1);
  box.innerHTML = `<div class="pd-s-row">`
    + `<div class="cdash-strip-msg pd-sm" role="button" tabindex="0" aria-expanded="false" title="Tap to show it all"><em class="pd-sm-time"></em><div class="pd-sm-t"></div></div>`
    + `<button type="button" class="pd-hist" aria-label="Earlier messages" aria-expanded="false"><i class="ph ph-clock-counter-clockwise"></i></button></div>`
    + `<div class="cdash-pop pd-pop-earlier" role="listbox" hidden>${stripMsgs.map((x, i) => `<button type="button" class="cdash-pop-row" data-i="${i}"><span class="cdash-pop-t">${plainUserText(x).replace(/</g, "&lt;")}</span><em>${clock(x)}</em></button>`).reverse().join("")}</div>`;
  draw();
  const msg = box.querySelector<HTMLElement>(".pd-sm")!;
  const hist = box.querySelector<HTMLElement>(".pd-hist")!;
  const pop = box.querySelector<HTMLElement>(".pd-pop-earlier")!;
  const toggle = (): void => {
    animateHeight(msg, () => {
      const open = msg.classList.toggle("open");
      msg.setAttribute("aria-expanded", String(open));
    });
  };
  msg.addEventListener("click", toggle);
  msg.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  hist.addEventListener("click", (e) => {
    e.stopPropagation();
    if (earlier.length === 0) return;
    pop.hidden = !pop.hidden;
    hist.setAttribute("aria-expanded", String(!pop.hidden));
  });
  pop.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!row) return;
    idx = Number(row.dataset.i);
    draw();
    pop.hidden = true;
    hist.setAttribute("aria-expanded", "false");
  });
  return box;
}

// ---- Dashboard pages: one instance per stage ------------------------------------------------------

class Columns {
  readonly ui: DashUi = initialUi();
  readonly answers: AnswersCard;
  readonly subsCard: SubsCard;
  readonly el = document.createElement("div");
  private pages!: HTMLElement;

  constructor(private readonly opts: { tabCounts: boolean; pushed: boolean }) {
    this.el.className = `cdash pd-dash${opts.pushed ? " pd-pushed" : ""}`;
    this.answers = new AnswersCard({
      sessionId: () => null, cwd: () => null, onSideChange: () => {}, decorate: () => {}, earlierDetails: () => [],
      expandQuestion: () => {}, subAlive: () => true, handOff: async () => true,
    } as never);
    this.subsCard = new SubsCard({ mainId: () => "main", cwd: () => null, sessions: () => [], openSub: () => {}, rerender: () => {} } as never);
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.build();
  }

  private ctx(): ZoneCtx {
    return {
      ui: this.ui, busy: false, idleAt: ago(99), subs: countSubs(subs),
      quick: { plan: true, decided: true, memory: true }, previewOwner: () => "Another chat", ctxChip: () => "", ctxPct: () => null,
    };
  }
  private zoneHtml(z: DrawnZone): string { return renderZone(z.id as never, z.state as never, this.ctx()); }
  private wrap(z: DrawnZone): string { return `<div class="pd-z" data-zone="${z.id}">${this.zoneHtml(z)}</div>`; }

  private build(): void {
    const n = (v: number) => (this.opts.tabCounts && v > 0 ? `<span class="pd-tab-n">${v}</span>` : "");
    const tab = (i: number, label: string, count: number) =>
      `<button type="button" role="tab" class="pd-tab${i === 1 ? " on" : ""}" data-pd="tab" data-page="${i}" aria-selected="${i === 1}">${label}${n(count)}</button>`;
    const col = (zs: DrawnZone[], cls: string) => `<div class="cdash-col ${cls}">${zs.map((z) => this.wrap(z)).join("")}</div>`;
    this.el.innerHTML = `<nav class="pd-tabs" role="tablist">${tab(0, "Chat", 0)}${tab(1, "Needs you", waitingCount)}${tab(2, "Progress", subCounts.working)}<span class="pd-ind"></span></nav>`
      + `<div class="pd-pages" data-pd-pages>`
      + `<div class="pd-page pd-chat" role="tabpanel"></div>`
      + `<div class="pd-page" role="tabpanel"><div class="pd-strip-slot"></div><div class="cdash-body">${col(dash.left, "cdash-left")}</div></div>`
      + `<div class="pd-page" role="tabpanel"><div class="pd-strip-slot"></div><div class="cdash-body">${col(dash.right, "cdash-right")}</div></div></div>`;
    this.pages = this.el.querySelector<HTMLElement>("[data-pd-pages]")!;
    this.el.querySelector(".pd-chat")!.append(messagesView());
    this.el.querySelectorAll(".pd-strip-slot").forEach((s) => s.append(stripCard("line")));
    this.pages.addEventListener("scroll", () => this.syncTabs(), { passive: true });
    const answers = dash.left.find((z) => z.id === "answers");
    const subsZone = dash.left.find((z) => z.id === "subchats");
    const ax = this.el.querySelector<HTMLElement>(".ax-host");
    if (ax && answers) this.answers.update(ax, answers.state as never);
    const sx = this.el.querySelector<HTMLElement>(".sx-host");
    if (sx && subsZone) this.subsCard.update(sx, subsZone.state as never);
    fillAgo(this.el);
  }

  /** The middle page is the default: scrolled to once the stage is in the document. */
  openMiddle(): void {
    this.pages.scrollLeft = this.pages.clientWidth;
    this.syncTabs();
  }
  goPage(i: number): void { this.pages.scrollTo({ left: i * this.pages.clientWidth, behavior: "smooth" }); }

  private syncTabs(): void {
    const p = this.pages.scrollLeft / Math.max(1, this.pages.clientWidth);
    this.el.querySelector<HTMLElement>(".pd-ind")!.style.setProperty("--p", String(Math.min(2, Math.max(0, p))));
    const idx = Math.round(p);
    this.el.querySelectorAll<HTMLElement>(".pd-tab").forEach((t, i) => {
      t.classList.toggle("on", i === idx);
      t.setAttribute("aria-selected", String(i === idx));
    });
  }

  private redrawZone(id: ZoneId): void {
    const z = [...dash.left, ...dash.right].find((x) => x.id === id);
    const slot = this.el.querySelector<HTMLElement>(`.pd-z[data-zone="${id}"]`);
    if (!z || !slot) return;
    slot.innerHTML = this.zoneHtml(z);
    fillAgo(slot);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-pd],[data-act]");
    if (!t) return;
    if (t.dataset.pd === "tab") { this.goPage(Number(t.dataset.page)); return; }
    const ui = this.ui;
    switch (t.dataset.act) {
      case "links-tab": ui.linksTab = attachTabOf(t.dataset.tab); this.redrawZone("links"); break;
      case "done-open": ui.doneOpen = ui.doneOpen === t.dataset.task ? null : (t.dataset.task ?? null); this.redrawZone("done"); break;
      case "done-card": ui.doneCard = ui.doneCard === t.dataset.sub ? null : (t.dataset.sub ?? null); this.redrawZone("done"); break;
      case "step": ui.openStep = ui.openStep === t.dataset.step ? null : (t.dataset.step ?? null); this.redrawZone("plan"); break;
      case "result-toggle": ui.resultOpen = ui.resultOpen === t.dataset.wkey ? null : (t.dataset.wkey ?? null); this.redrawZone("plan"); break;
      default: break;
    }
  }
}

// ---- Header variants ---------------------------------------------------------------------------------

type HeaderVariant = "line" | "chips" | "ring";

const menuHtml = `<div class="pd-pop" role="menu" hidden>`
  + `<button type="button" role="menuitem"><i class="ph ph-brain"></i>Model and effort<em>sonnet, high</em></button>`
  + `<button type="button" role="menuitem"><i class="ph ph-gauge"></i>Account and usage</button>`
  + `<button type="button" role="menuitem"><i class="ph ph-push-pin"></i>Pin chat</button>`
  + `<button type="button" role="menuitem"><i class="ph ph-clock-counter-clockwise"></i>History</button></div>`;

function newHeader(variant: HeaderVariant, onStatus: () => void): HTMLElement {
  const el = document.createElement("header");
  el.className = `pd-hdr pd-hdr--${variant}`;
  const status = variant === "line"
    ? `<button type="button" class="pd-status pd-status--line" data-pd="status">${waitingCount} waiting<em>·</em>${subCounts.working} working</button>`
    : "";
  const chips = variant === "chips"
    ? `<button type="button" class="pd-status pd-status--chips" data-pd="status" aria-label="${waitingCount} waiting, ${subCounts.working} working"><span class="pd-cnt pd-cnt--warn"><i></i>${waitingCount}</span><span class="pd-cnt pd-cnt--work"><i></i>${subCounts.working}</span></button>`
    : "";
  el.innerHTML = `<div class="pd-hrow"><div class="pd-ttl"><b class="pd-name">${PROJECT}</b>${status}</div>${chips}`
    + `<button type="button" class="icon-btn pd-menu" aria-label="More" aria-haspopup="menu" aria-expanded="false"><i class="ph ph-dots-three-vertical"></i></button></div>${menuHtml}`;
  el.querySelector("[data-pd='status']")?.addEventListener("click", onStatus);
  const menu = el.querySelector<HTMLElement>(".pd-menu")!;
  const pop = el.querySelector<HTMLElement>(".pd-pop")!;
  menu.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; menu.setAttribute("aria-expanded", String(!pop.hidden)); });
  pop.addEventListener("click", () => { pop.hidden = true; menu.setAttribute("aria-expanded", "false"); });
  return el;
}

/** Today's header: the real SessionHeader of a project's main chat. */
function todayHeader(): HTMLElement {
  const h = new SessionHeader({ title: "Conductor main chat", meta: PROJECT });
  (h as unknown as { showAsProjectMain(c: string | null, m: string | null): void }).showAsProjectMain(null, null);
  (h as unknown as { _wrap: HTMLElement })._wrap.innerHTML = monogram;
  h.setConfig("claude-sonnet-4-6", "high");
  h.leadSlot.innerHTML = `<button type="button" class="icon-btn" aria-label="Back to chats"><i class="ph ph-caret-left"></i></button>`;
  h.trailSlot.innerHTML = `<button type="button" class="icon-btn" aria-label="More"><i class="ph ph-dots-three-vertical"></i></button>`;
  return h.el;
}

function messagesView(): HTMLElement {
  const el = document.createElement("div");
  el.className = "session-messages pd-messages";
  el.innerHTML = renderer.messages.map((m) => cardHtml(m as never)).join("");
  return el;
}

// ---- Heads and stages ---------------------------------------------------------------------------------

type HeadMode = "overlay" | "pushed";

/** The floating chat head stack (chat-heads.css): stubs. The active head sits in the header's 68px
 *  gutter; the others either float over the page ("pushed": the page makes room) or hide behind a
 *  tap on the active head ("overlay": the page keeps its full width). */
function heads(mode: HeadMode, ring: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `pd-heads pd-heads--${mode}${mode === "pushed" ? " is-open" : ""}`;
  const others = [["RO", "#6d5bd0"], ["TM", "#2f8f83"], ["WM", "#b8704a"]];
  wrap.innerHTML = `<button type="button" class="pd-head is-active" aria-label="Conductor, chats" aria-expanded="${mode === "pushed"}">${ring ? ringHtml({ kind: "solid", tone: "attention", pulse: true }) : ""}${monogram}</button>`
    + others.map(([t, c], i) => `<span class="pd-head is-dim" style="--i:${i};--c:${c}"><span class="pd-dim-face">${t}</span></span>`).join("");
  if (mode === "overlay") {
    const a = wrap.querySelector<HTMLElement>(".is-active")!;
    a.addEventListener("click", () => {
      const open = wrap.classList.toggle("is-open");
      a.setAttribute("aria-expanded", String(open));
    });
  }
  return wrap;
}

function phone(label: string, header: HTMLElement, body: HTMLElement, opts: { today?: boolean; headMode?: HeadMode; ring?: boolean } = {}): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "pd-phone";
  frame.dataset.stage = label;
  const bar = document.createElement("div");
  bar.className = "pd-statusbar";
  bar.innerHTML = `<span>9:41</span><span class="pd-sb-r"><i class="ph ph-cell-signal-full"></i><i class="ph ph-wifi-high"></i><i class="ph ph-battery-full"></i></span>`;
  const screen = document.createElement("div");
  screen.className = "pd-screen";
  if (opts.today) {
    const root = document.createElement("div");
    root.className = "view-sessions";
    root.dataset.mobilePane = "chat";
    root.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0";
    root.append(header, body);
    screen.append(root);
  } else {
    screen.append(header, body);
  }
  screen.append(heads(opts.headMode ?? "overlay", !!opts.ring));
  frame.append(bar, screen);
  return frame;
}

function columnsStage(label: string, header: HeaderVariant, o: { tabCounts: boolean; pushed?: boolean; ring?: boolean; headMode?: HeadMode }): { frame: HTMLElement; cols: Columns } {
  const cols = new Columns({ tabCounts: o.tabCounts, pushed: !!o.pushed });
  const body = document.createElement("div");
  body.className = "pd-body";
  body.append(cols.el);
  const hdr = newHeader(header, () => cols.goPage(1));
  return { frame: phone(label, hdr, body, { headMode: o.headMode, ring: o.ring }), cols };
}

const STAGES: { id: string; title: string; pitch: string; note: string }[] = [
  { id: "h1", title: "Header 1. Status as a text line", pitch: "Name with the status under it as small text: \"2 waiting, 1 working\". Plain head, plain tabs. Tap the line to jump to Needs you.", note: "Status is words, so it can say more, but it costs a second line of header height." },
  { id: "h2", title: "Header 2. Dot and count chips", pitch: "One row: name, then a warm dot with the waiting count and a green dot with the working count. Plain head, plain tabs.", note: "Compact and glanceable, but two bare numbers lose their words; you learn the colours." },
  { id: "h3", title: "Header 3. Ring on the head, counts on the tabs", pitch: "Name only. The state ring sits on the head and the Needs you and Progress tabs carry the counts, so the header says nothing twice.", note: "Cleanest header, but the counts are one swipe from the chat column's header: you only see them with the tab strip." },
];

const CARD_VARIANTS: { v: StripVariant; title: string; note: string }[] = [
  { v: "line", title: "1. One line, trailing history icon", note: "Cropped to one line, icon at the end, tap the text for time and the full message." },
  { v: "clamp", title: "2. Two-line clamp, trailing icon", note: "The real clamp (two lines) with the icon beside it." },
  { v: "chip", title: "3. Chip", note: "A single pill: one line, icon inside the pill, tap to open into a card." },
  { v: "corner", title: "4. Icon on the corner", note: "Two-line card with the history icon overlapping its top-right corner, so the text keeps the full width." },
];

function cardsPanel(): HTMLElement {
  const el = document.createElement("div");
  el.className = "pd-cards";
  for (const c of CARD_VARIANTS) {
    const sec = document.createElement("div");
    sec.className = "pd-card-sec";
    sec.innerHTML = `<div class="pd-lbl">${c.title}</div>`;
    sec.append(stripCard(c.v));
    const note = document.createElement("p");
    note.className = "pd-cost";
    note.textContent = c.note;
    sec.append(note);
    el.append(sec);
  }
  return el;
}

// ---- Board shell ----------------------------------------------------------------------------------------

const style = document.createElement("style");
// Appended after the bundled app css so the equal-specificity board rules win; every rule is scoped.
style.textContent = `
html,body.pd-board{visibility:visible!important;display:block!important;height:auto!important;overflow:auto!important;user-select:text!important;background:var(--color-background)!important;padding:0!important}
html body.pd-board #pd-root{max-width:1700px;margin:0 auto;padding:18px 20px 40px}
.pd-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.pd-top h1{font-size:19px;font-weight:600;margin:0}
.pd-badge{font-size:10px;letter-spacing:.06em;color:var(--color-text-muted);border:1px solid var(--color-border);border-radius:4px;padding:0 5px}
.pd-sub{color:var(--color-text-muted);font-size:13px;margin:6px 0 4px;max-width:900px;line-height:1.5}
.pd-h2{font-size:15px;font-weight:600;margin:30px 0 0}
.pd-grid{display:flex;flex-wrap:wrap;gap:30px;align-items:flex-start;margin-top:14px}
.pd-sec{width:390px}
.pd-sec h2{font-size:14px;font-weight:600;margin:0 0 3px}
.pd-pitch{font-size:12.5px;color:var(--color-text);margin:0 0 10px;line-height:1.45;min-height:54px}
.pd-cost{font-size:12px;color:var(--color-text-muted);margin:8px 0 0;line-height:1.45}
.pd-lbl{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-muted);margin:0 0 6px}
.pd-note{font-size:12px;color:var(--color-text-muted);margin:12px 0 0;max-width:900px;line-height:1.5}

.pd-phone{box-sizing:border-box;width:390px;height:780px;display:flex;flex-direction:column;border:1px solid var(--color-border);border-radius:26px;overflow:hidden;background:var(--color-background);position:relative}
.pd-statusbar{flex:none;height:28px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;font-size:11.5px;font-weight:600;color:var(--color-text-muted);background:var(--color-surface-alt)}
.pd-sb-r{display:inline-flex;gap:5px;font-size:13px}
.pd-screen{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.pd-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.pd-body > .pd-dash{flex:1 1 auto;min-height:0}
.pd-messages{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:12px}
.pd-screen .view-sessions .session-messages{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px}

/* header: one 56px row, starting right of the 68px head gutter */
.pd-hdr{position:relative;flex:none;background:var(--color-surface-alt);border-bottom:1px solid var(--color-border);padding-top:env(safe-area-inset-top,0px);z-index:5}
.pd-hrow{display:flex;align-items:center;gap:6px;padding:6px 2px 6px 68px;min-height:56px}
.pd-hdr .icon-btn{width:44px;height:44px;flex:none}
.pd-ttl{min-width:0;flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:1px}
.pd-name{font-size:1rem;font-weight:600;color:var(--color-text);line-height:1.15;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pd-status{position:relative;display:inline-flex;align-items:center;border:0;background:none;color:var(--color-text-muted);font:inherit;font-size:12px;padding:0;cursor:pointer;font-variant-numeric:tabular-nums}
.pd-status::after{content:"";position:absolute;inset:-10px -6px}
.pd-status--line em{font-style:normal;margin:0 5px;opacity:.6}
.pd-status--chips{flex:none;gap:6px}
.pd-cnt{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;background:var(--color-surface);color:var(--color-text);font-size:12.5px;font-weight:600}
.pd-cnt i{width:7px;height:7px;border-radius:50%}
.pd-cnt--warn i{background:var(--color-warning)}
.pd-cnt--work i{background:var(--color-success)}
.pd-hdr .icon-btn:focus-visible,.pd-status:focus-visible,.pd-tab:focus-visible,.pd-head:focus-visible,.pd-hist:focus-visible,.pd-sm:focus-visible{outline:2px solid var(--color-primary);outline-offset:1px}
.pd-pop{position:absolute;right:6px;top:calc(100% - 4px);min-width:228px;padding:5px;border:1px solid var(--color-border);border-radius:12px;background:var(--color-surface);box-shadow:0 10px 28px rgba(0,0,0,.4);z-index:20;transform-origin:top right;transition:opacity .15s ease,transform .15s ease,visibility 0s}
.pd-pop[hidden]{display:block!important;opacity:0;visibility:hidden;transform:scale(.95);pointer-events:none;transition:opacity .15s ease,transform .15s ease,visibility 0s .15s}
.pd-pop button{display:flex;align-items:center;gap:9px;width:100%;height:44px;padding:0 10px;border:0;border-radius:8px;background:none;color:var(--color-text);font:inherit;font-size:13.5px;text-align:left;cursor:pointer}
.pd-pop button:active{background:var(--color-surface-alt)}
.pd-pop em{margin-left:auto;font-style:normal;font-size:11.5px;color:var(--color-text-muted)}
@media (hover:hover){.pd-pop button:hover{background:var(--color-surface-alt)}}

/* the head stack (stubs) */
.pd-heads{position:absolute;left:0;top:0;bottom:0;width:0;z-index:40;pointer-events:none}
.pd-head{position:absolute;left:8px;width:44px;height:44px;display:grid;place-items:center;border:0;padding:0;border-radius:50%;background:none}
.pd-head.is-active{top:6px;pointer-events:none;cursor:default}
.pd-heads--overlay .pd-head.is-active{pointer-events:auto;cursor:pointer}
.pd-head .avatar-ring{position:absolute;inset:-2px;width:calc(100% + 4px);height:calc(100% + 4px)}
.pd-head .session-header-project-face{width:38px;height:38px;display:grid;place-items:center}
.pd-head .proj-face{display:grid;place-items:center;width:100%;height:100%}
.pd-head.is-dim{top:calc(6px + (var(--i) + 1) * 52px);background:var(--c);box-shadow:0 4px 12px rgba(0,0,0,.45);opacity:0;transform:translateY(-10px) scale(.92);transition:opacity .2s cubic-bezier(.22,1,.36,1),transform .2s cubic-bezier(.22,1,.36,1);transition-delay:calc(var(--i) * 40ms)}
.pd-dim-face{font-size:.85rem;font-weight:700;color:#fff}
.pd-heads.is-open .pd-head.is-dim{opacity:1;transform:none;pointer-events:auto}
.pd-heads--pushed .pd-head.is-dim{transition:none}

/* tab strip and the three swipe pages */
.pd-dash .pd-tabs{position:relative;flex:none;display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--color-border);background:var(--color-surface-alt)}
.pd-tab{display:flex;align-items:center;justify-content:center;gap:7px;height:44px;border:0;background:none;color:var(--color-text-muted);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:color .15s ease,background .15s ease}
.pd-tab.on{color:var(--color-text)}
.pd-tab:active{background:var(--color-surface)}
.pd-tab-n{min-width:18px;height:18px;padding:0 5px;display:inline-grid;place-items:center;border-radius:9px;background:var(--color-surface);font-size:11px;font-variant-numeric:tabular-nums}
.pd-tab.on .pd-tab-n{background:color-mix(in srgb,var(--color-primary) 28%,var(--color-surface))}
.pd-ind{position:absolute;left:0;bottom:-1px;width:33.3333%;height:2px;background:var(--color-primary);--p:1;transform:translateX(calc(var(--p) * 100%))}
.pd-dash .pd-pages{flex:1;min-height:0;display:flex;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;scrollbar-width:none}
.pd-dash .pd-pages::-webkit-scrollbar{display:none}
.pd-dash .pd-page{flex:0 0 100%;min-width:0;scroll-snap-align:start;scroll-snap-stop:always;display:flex;flex-direction:column}
.pd-dash .pd-page .cdash-body{flex:1;min-height:0;min-width:0}
.pd-dash .pd-chat{overflow:hidden}
.pd-dash .pd-chat .session-messages{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
/* pushed treatment: the open stack takes the left 60px of the tabs and of every page */
.pd-pushed .pd-tabs{padding-left:60px}
.pd-pushed .pd-page{padding-left:60px}

/* the latest-message card */
.pd-s{padding:8px 12px}
.pd-s-row{position:relative;display:flex;align-items:flex-start;gap:6px}
.pd-sm{position:relative;flex:1;min-width:0;padding:7px 11px;border-radius:12px;font-size:13px;line-height:1.4;cursor:pointer}
.pd-sm-time{display:none;font-style:normal;font-size:11px;color:var(--color-text-muted);margin-bottom:2px}
.pd-sm.open .pd-sm-time{display:block}
.pd-sm-t{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.pd-s--line .pd-sm-t{-webkit-line-clamp:1}
.pd-s--clamp .pd-sm-t,.pd-s--corner .pd-sm-t,.pd-s--chip .pd-sm-t{-webkit-line-clamp:2}
.pd-s--chip .pd-sm-t{-webkit-line-clamp:1}
.pd-sm.open .pd-sm-t{display:block;-webkit-line-clamp:unset}
.pd-hist{position:relative;flex:none;width:34px;height:34px;display:grid;place-items:center;border:0;border-radius:50%;background:var(--color-surface);color:var(--color-text-muted);font-size:17px;cursor:pointer;transition:background .15s ease,color .15s ease,transform .12s ease}
.pd-hist::after{content:"";position:absolute;inset:-5px}
.pd-hist:active{transform:scale(.97)}
.pd-hist[aria-expanded="true"]{color:var(--color-text);background:var(--color-surface-alt)}
@media (hover:hover){.pd-hist:hover{color:var(--color-text);background:var(--color-surface-alt)}}
/* chip: one pill with the icon inside it */
.pd-s--chip .pd-s-row{gap:0;align-items:center;border-radius:999px;background:color-mix(in srgb,var(--color-primary) 12%,var(--color-surface));padding-right:4px}
.pd-s--chip .pd-sm{background:none;border-radius:999px;padding:7px 8px 7px 14px}
.pd-s--chip .pd-sm.open{border-radius:14px}
.pd-s--chip .pd-s-row:has(.open){border-radius:16px;align-items:flex-start;padding-top:4px}
/* corner: the icon overlaps the card's top-right corner */
.pd-s--corner{padding-top:14px;padding-right:16px}
.pd-s--corner .pd-hist{position:absolute;top:-8px;right:-6px;width:30px;height:30px;font-size:15px;border:2px solid var(--color-background);z-index:2}
.pd-s--corner .pd-sm{padding-right:30px}
.pd-s .pd-pop-earlier{top:calc(100% - 4px);right:12px}
.pd-cards{box-sizing:border-box;width:390px;border:1px solid var(--color-border);border-radius:16px;background:var(--color-background);padding:6px 0 10px}
.pd-card-sec{padding:6px 12px 2px}
.pd-card-sec .cdash-strip{border:1px solid var(--color-border);border-radius:12px;margin-top:2px;position:relative}
@media (prefers-reduced-motion:reduce){.pd-head.is-dim,.pd-pop{transition-duration:.01ms}}
`;
document.head.appendChild(style);

function boardHtml(): string {
  return `
  <div class="pd-top"><h1>Chat dashboard on the phone, round 2</h1><span class="pd-badge">SCRATCH / PREVIEW ONLY</span></div>
  <p class="pd-sub">Three swipe columns: Chat on the left, Needs you in the middle (the one it opens on), Progress on the right. Three header variants sit above the same body, then four variants of the latest-message card, then two ways the chat head stack can share the screen. Everything is a true 390px phone; tap, scroll and swipe inside it.</p>
  <p class="pd-note">Real: the dashboard model over a real chat transcript, every card renderer, the Answers, Subchats and Done cards, the real Messages view for the Chat column, the real session header for Today, and the app's own phone css (forced on, since the panel is wider than 390px). Stubbed: the chat heads, the Chat column's composer, Previews and Images tabs, sub peeks and chat menus.</p>
  <h2 class="pd-h2">Header variants (same three-column body under each)</h2>
  <div class="pd-grid">
    <section class="pd-sec"><h2>Today (baseline)</h2><p class="pd-pitch">The phone as shipped: a main chat shows only the Messages transcript, real header, head stub in the gutter.</p><div class="pd-slot" data-slot="today"></div><p class="pd-cost">Back, face, name, model and effort, and the menu all share one row.</p></section>
    ${STAGES.map((s) => `<section class="pd-sec"><h2>${s.title}</h2><p class="pd-pitch">${s.pitch}</p><div class="pd-slot" data-slot="${s.id}"></div><p class="pd-cost">${s.note}</p></section>`).join("")}
  </div>
  <p class="pd-note">All three: no account, usage or model chip in the header (model and effort, account and usage are inside the top-right menu). The head sits in the 68px gutter the real app reserves, and tapping it brings the rest of the stack out as an overlay, so the page keeps its full width (that is treatment B below). Only header 3 draws the ring on the head; headers 1 and 2 keep the head plain because the status already lives in the header. Counts live on the tabs only in header 3.</p>
  <h2 class="pd-h2">The latest-message card, four ways</h2>
  <div class="pd-grid"><section class="pd-sec"><p class="pd-pitch">No "You" label and no time at rest. Tap the text to open it: the time and the whole message. The clock icon alone (no count) lists earlier messages. Header 1's stage uses variant 1.</p><div class="pd-slot" data-slot="cards"></div></section></div>
  <h2 class="pd-h2">Head stack and the page: two treatments</h2>
  <div class="pd-grid">
    <section class="pd-sec"><h2>A. Stack open: the page makes room</h2><p class="pd-pitch">The stack floats over the left edge, so the tabs and every page get 60px of left padding (60 of 390px, 15% of the width).</p><div class="pd-slot" data-slot="tA"></div><p class="pd-cost">Always one tap from another chat, but cards are 60px narrower the whole time.</p></section>
    <section class="pd-sec"><h2>B. Stack collapses to the active head</h2><p class="pd-pitch">Only the active head stays, in the header gutter; the page uses the full width. Tap the head to float the rest of the stack over the page.</p><div class="pd-slot" data-slot="tB"></div><p class="pd-cost">Cards keep full width, but switching chat is one tap further, and the open stack covers the card edge while it is up.</p></section>
  </div>`;
}

function mount(): void {
  const root = document.getElementById("pd-root")!;
  root.innerHTML = boardHtml();
  const put = (slot: string, el: HTMLElement) => root.querySelector(`[data-slot="${slot}"]`)!.append(el);
  const todayBody = messagesView();
  todayBody.classList.remove("pd-messages");
  put("today", phone("today", todayHeader(), todayBody, { today: true }));
  const all: Columns[] = [];
  const mk = (slot: string, label: string, header: HeaderVariant, o: Parameters<typeof columnsStage>[2]) => {
    const s = columnsStage(label, header, o);
    put(slot, s.frame);
    all.push(s.cols);
  };
  mk("h1", "h1", "line", { tabCounts: false });
  mk("h2", "h2", "chips", { tabCounts: false });
  mk("h3", "h3", "ring", { tabCounts: true, ring: true });
  put("cards", cardsPanel());
  mk("tA", "tA", "line", { tabCounts: false, pushed: true, headMode: "pushed" });
  mk("tB", "tB", "line", { tabCounts: false });
  // Every stage opens on the middle page, once it is laid out.
  requestAnimationFrame(() => requestAnimationFrame(() => all.forEach((c) => c.openMiddle())));
}

mount();
