import { invoke } from "../../shared/ipc";
import { isRemote } from "../../shared/transport";
import type { ContextStatus } from "../../types/ipc.generated";
import { state } from "./state";
import { cwdToProjectName, sessionSubtitle } from "./sessions-helpers";
import { ctxStatusCache } from "./session-statusbar-helpers";
import { questionProgressFor } from "./question-progress";
import { buildHoverCardHtml } from "./sidebar-hover-card-html";
import { mainChatInfo } from "./main-chat";
import { isSubchatsOn } from "./permission-modal/gating";

/** Desktop-only hover card for a sidebar row: plan steps or question list,
 *  a state line with a timer, and the context %. The phone gets none (Joe,
 *  2026-11-03: the tap-shown tooltip there was in the way), so this never
 *  binds when the transport is remote or the pointer cannot hover. */
const SHOW_DELAY_MS = 350;
const PAD = 10;

let card: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let currentSession: string | null = null;

function ensureCard(): HTMLElement {
  if (card?.isConnected) return card;
  card = document.createElement("div");
  card.className = "info-tooltip cc-row-card";
  document.body.appendChild(card);
  return card;
}

export function hideHoverCard(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (card) card.style.display = "none";
  currentSession = null;
}

function place(li: HTMLElement, el: HTMLElement): void {
  const a = li.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  let left = a.right + PAD;
  if (left + t.width > window.innerWidth - PAD) left = a.left - t.width - PAD;
  left = Math.max(PAD, left);
  let top = a.top + a.height / 2 - t.height / 2;
  top = Math.max(PAD, Math.min(top, window.innerHeight - PAD - t.height));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function contextPct(sessionId: string): number | null {
  const c = ctxStatusCache.get(sessionId);
  return c ? c.pct_used : null;
}

function render(li: HTMLElement, sessionId: string): void {
  const s = state.sessions.find((x) => x.session_id === sessionId);
  if (!s) return hideHoverCard();
  const el = ensureCard();
  // Read fresh on every render so the rows track the subs while the card is up.
  const main = isSubchatsOn(sessionId) ? mainChatInfo(s, state.sessions) : null;
  el.innerHTML = buildHoverCardHtml({
    subs: main?.hoverRows,
    title: sessionSubtitle(s),
    project: cwdToProjectName(String(s.cwd ?? "")),
    st: li.dataset.st ?? "",
    plan: s.progress?.plan,
    question: questionProgressFor(sessionId),
    stateSince: s.progress?.state_since,
    contextPct: contextPct(sessionId),
    now: Date.now(),
  });
  el.style.display = "block";
  place(li, el);
}

function show(li: HTMLElement, sessionId: string): void {
  currentSession = sessionId;
  render(li, sessionId);
  // Context % is a daemon computation, so it loads after the card is up. The
  // cached value is only the instant first paint: the statusbar refreshes that
  // shared cache for the selected chat alone, so a background chat's entry
  // would otherwise stay frozen at its first hover. The card re-renders in
  // place only when the number moved and the pointer is still on this row.
  const shown = contextPct(sessionId);
  void invoke<ContextStatus | null>("context_status", { sessionId })
    .then((r) => {
      if (!r) return;
      ctxStatusCache.set(sessionId, r);
      if (r.pct_used === shown) return;
      if (currentSession === sessionId && li.isConnected) render(li, sessionId);
    })
    .catch(() => { /* no transcript yet: the line just stays absent */ });
}

export function attachSidebarHoverCard(listEl: HTMLElement): void {
  if (listEl.dataset.hoverCardWired === "1") return;
  // jsdom (the unit-test DOM) has no matchMedia; assume a hover-capable pointer there.
  const canHover = typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover)").matches;
  if (isRemote() || !canHover) return;
  listEl.dataset.hoverCardWired = "1";

  listEl.addEventListener("mouseover", (e) => {
    const target = e.target as HTMLElement;
    // A row's own [data-tip] anchors (title, battery, badges) keep their small
    // tip; the card waits for the pointer to rest on plain row space.
    if (target.closest("[data-tip]")) { hideHoverCard(); return; }
    const li = target.closest<HTMLElement>("li[data-session-id]");
    const id = li?.dataset.sessionId;
    if (!li || !id) { hideHoverCard(); return; }
    if (id === currentSession) return;
    hideHoverCard();
    timer = setTimeout(() => show(li, id), SHOW_DELAY_MS);
  });
  listEl.addEventListener("mouseleave", hideHoverCard);
  listEl.addEventListener("mousedown", hideHoverCard);
  listEl.addEventListener("scroll", hideHoverCard, true);
}
