// The hover card on a Subchats-card avatar (docs/chat-dashboard-design.md, "Seeing
// what subs are doing"). It replaces the avatar's native `title`, which could only
// say one line. The chrome is the sidebar row card's (sidebar-hover-card.css), the
// lines come from buildSubHoverCardHtml. Desktop only, like the sidebar's card: a
// finger cannot hover, and the avatar keeps its aria-label.

import "../sidebar-hover-card.css";
import { invoke } from "../../../shared/ipc";
import { isRemote } from "../../../shared/transport";
import type { ContextStatus } from "../../../types/ipc.generated";
import { ctxStatusCache } from "../session-statusbar-helpers";
import { buildSubHoverCardHtml, type SubHoverInput } from "../sidebar-hover-card-html";

const SHOW_DELAY_MS = 350;
const PAD = 8;

/** What the card needs besides the clock and the context figure, or null when the sub is gone. */
export type SubHoverResolver = (subId: string) => Omit<SubHoverInput, "contextPct" | "now"> | null;

let card: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let current: string | null = null;
let pending: string | null = null;

function ensureCard(): HTMLElement {
  if (card?.isConnected) return card;
  card = document.createElement("div");
  card.className = "info-tooltip cc-row-card sx-hover-card";
  card.setAttribute("role", "tooltip");
  document.body.appendChild(card);
  return card;
}

export function hideSubHover(): void {
  if (timer) clearTimeout(timer);
  if (ticker) clearInterval(ticker);
  timer = null;
  ticker = null;
  current = null;
  pending = null;
  if (card) card.style.display = "none";
}

/** Under the avatar, or above it when the window ends first; clamped sideways. */
function place(anchor: HTMLElement, el: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  let top = a.bottom + PAD;
  if (top + t.height > window.innerHeight - PAD) top = Math.max(PAD, a.top - t.height - PAD);
  const left = Math.max(PAD, Math.min(a.left + a.width / 2 - t.width / 2, window.innerWidth - PAD - t.width));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function contextPct(id: string): number | null {
  return ctxStatusCache.get(id)?.pct_used ?? null;
}

function render(anchor: HTMLElement, id: string, resolve: SubHoverResolver): void {
  const input = resolve(id);
  if (!input) return hideSubHover();
  const el = ensureCard();
  el.dataset.sub = id;
  el.dataset.kind = input.kind;
  el.innerHTML = buildSubHoverCardHtml({ ...input, contextPct: contextPct(id), now: Date.now() });
  el.style.display = "block";
  place(anchor, el);
}

function show(anchor: HTMLElement, id: string, resolve: SubHoverResolver): void {
  current = id;
  pending = null;
  render(anchor, id, resolve);
  // Time running and "18s ago" tick; the daemon's row only changes when the sub does.
  ticker = setInterval(() => {
    if (!anchor.isConnected) return hideSubHover();
    render(anchor, id, resolve);
  }, 1000);
  // The context figure is a daemon computation that arrives after the card is up.
  const shown = contextPct(id);
  void invoke<ContextStatus | null>("context_status", { sessionId: id })
    .then((r) => {
      if (!r) return;
      ctxStatusCache.set(id, r);
      if (r.pct_used !== shown && current === id && anchor.isConnected) render(anchor, id, resolve);
    })
    .catch(() => { /* no transcript yet: the line stays absent */ });
}

/** Wires the card to every `.sx-av` under `host`. Safe to call once per host. */
export function attachSubHover(host: HTMLElement, resolve: SubHoverResolver): void {
  const canHover = typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover)").matches;
  if (isRemote() || !canHover) return;
  host.addEventListener("mouseover", (e) => {
    const av = (e.target as HTMLElement).closest<HTMLElement>(".sx-av");
    const id = av?.dataset.sub;
    if (!av || !id) return hideSubHover();
    // Moving between the avatar's own children fires mouseover again; the pending show stands.
    if (id === current || id === pending) return;
    hideSubHover();
    pending = id;
    timer = setTimeout(() => show(av, id, resolve), SHOW_DELAY_MS);
  });
  host.addEventListener("mouseleave", hideSubHover);
  host.addEventListener("mousedown", hideSubHover);
  host.addEventListener("contextmenu", hideSubHover);
}
