// Ticket mentions in chat: ids in a message become links to the ticket (for a
// chat whose project has a tracker, see src-tauri/src/tickets.rs), and hovering
// any ticket link - ours or one Claude wrote as markdown - shows a small card
// with its title, state, owner and type. Tokens stay in the backend; this only
// ever sees the summary.

import { invoke } from "../ipc";
import { escapeHtml } from "../escape-html";
import type { TicketSummary, TrackerInfo, TrackerKind } from "../../types/ipc.generated";

// ── tracker per repo ──────────────────────────────────────────────────

// Settled answers are read synchronously so a streaming bubble rebuilt on
// every delta re-links without a flash; `inflight` dedupes the first lookup.
const trackers = new Map<string, TrackerInfo | null>();
const inflight = new Map<string, Promise<TrackerInfo | null>>();

function trackerFor(cwd: string): Promise<TrackerInfo | null> {
  let p = inflight.get(cwd);
  if (!p) {
    p = invoke<TrackerInfo | null>("get_ticket_tracker", { cwd })
      .then((t) => {
        trackers.set(cwd, t ?? null);
        return t ?? null;
      })
      .catch(() => {
        inflight.delete(cwd); // retry on the next render instead of caching a failure
        return null;
      });
    inflight.set(cwd, p);
  }
  return p;
}

/** Drops a repo's cached tracker after its project setting changes. */
export function forgetTicketTracker(cwd: string): void {
  trackers.delete(cwd);
  inflight.delete(cwd);
}

export function ticketUrl(t: Pick<TrackerInfo, "kind" | "workspace">, id: string): string {
  const ws = encodeURIComponent(t.workspace);
  return t.kind === "shortcut"
    ? `https://app.shortcut.com/${ws}/story/${id.replace(/^sc-/i, "")}`
    : `https://linear.app/${ws}/issue/${id}`;
}

function idPattern(t: TrackerInfo): RegExp | null {
  if (t.kind === "shortcut") return /(?<![\w/-])sc-\d{1,7}(?![\w-])/gi;
  const keys = t.team_keys.filter((k) => /^[A-Z][A-Z0-9]*$/.test(k));
  if (t.kind !== "linear" || keys.length === 0) return null;
  return new RegExp(`(?<![\\w/-])(?:${keys.join("|")})-\\d+(?![\\w-])`, "g");
}

function anchorFor(t: TrackerInfo, id: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "ticket-ref";
  a.href = ticketUrl(t, id);
  a.textContent = id;
  return a;
}

/** Wraps ticket ids in `root`'s text in links. Skips existing links and code
 *  blocks; a bare 5-6 digit Shortcut id links only as a whole inline-code span
 *  (`55411`), since in prose it is as likely a count as a story. */
export function applyTicketLinks(root: HTMLElement, t: TrackerInfo): void {
  const re = idPattern(t);
  if (!re) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("a, pre, .ticket-ref, .commit-ref") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    re.lastIndex = 0;
    if (re.test(n.nodeValue ?? "")) hits.push(n as Text);
  }
  for (const node of hits) {
    const text = node.nodeValue ?? "";
    const frag = document.createDocumentFragment();
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      frag.append(text.slice(last, m.index), anchorFor(t, t.kind === "shortcut" ? m[0].toLowerCase() : m[0]));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  if (t.kind === "shortcut") {
    root.querySelectorAll<HTMLElement>("code").forEach((code) => {
      if (code.closest("pre, a") || code.children.length > 0) return;
      const txt = code.textContent ?? "";
      if (/^\d{5,6}$/.test(txt)) code.replaceChildren(anchorFor(t, txt));
    });
  }
}

export async function linkifyTickets(root: HTMLElement, cwd: string | undefined): Promise<void> {
  if (!cwd) return;
  const known = trackers.get(cwd);
  const t = known !== undefined ? known : await trackerFor(cwd);
  if (t && root.isConnected) applyTicketLinks(root, t);
}

// ── hover card ────────────────────────────────────────────────────────

const SHORTCUT_URL = /^https:\/\/app\.shortcut\.com\/([^/]+)\/story\/(\d+)/;
const LINEAR_URL = /^https:\/\/linear\.app\/([^/]+)\/issue\/([A-Z][A-Z0-9]*-\d+)/;

export function parseTicketUrl(href: string): { kind: TrackerKind; workspace: string; id: string } | null {
  const sc = SHORTCUT_URL.exec(href);
  if (sc) return { kind: "shortcut", workspace: sc[1]!, id: `sc-${sc[2]}` };
  const li = LINEAR_URL.exec(href);
  if (li) return { kind: "linear", workspace: li[1]!, id: li[2]! };
  return null;
}

// A card only after the pointer rests, so sweeping across a message doesn't
// fire an API call per link it crosses.
const HOVER_DELAY_MS = 350;

const summaries = new Map<string, Promise<TicketSummary>>();
let card: HTMLElement | null = null;
let cardAnchor: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function summaryFor(kind: TrackerKind, workspace: string, id: string): Promise<TicketSummary> {
  const key = `${kind}/${workspace}/${id}`;
  let p = summaries.get(key);
  if (!p) {
    p = invoke<TicketSummary>("get_ticket_summary", { kind, workspace, id });
    p.catch(() => summaries.delete(key));
    summaries.set(key, p);
  }
  return p;
}

function hideCard(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  card?.remove();
  card = null;
  cardAnchor = null;
}

function place(anchor: HTMLElement, el: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8));
  const below = a.bottom + 6 + r.height <= window.innerHeight - 8;
  el.style.left = `${left}px`;
  el.style.top = `${below ? a.bottom + 6 : Math.max(8, a.top - r.height - 6)}px`;
}

export function ticketCardHtml(s: TicketSummary): string {
  const chip = (c: string, cls: string) => (c ? `<span class="ticket-card-chip${cls}">${escapeHtml(c)}</span>` : "");
  const chips = chip(s.state, "") + chip(s.ticket_type, " ticket-card-type");
  const owner = s.owner ? escapeHtml(s.owner) : "Unassigned";
  return `<div class="ticket-card-id">${escapeHtml(s.id)}</div><div class="ticket-card-title">${escapeHtml(s.title)}</div><div class="ticket-card-meta">${chips}<span class="ticket-card-owner"><i class="ph ph-user"></i>${owner}</span></div>`;
}

async function showCard(anchor: HTMLAnchorElement): Promise<void> {
  const ref = parseTicketUrl(anchor.href);
  if (!ref) return;
  const el = document.createElement("div");
  el.className = "ticket-card";
  el.innerHTML = `<div class="ticket-card-id">${escapeHtml(ref.id)}</div><div class="ticket-card-loading">Loading…</div>`;
  document.body.appendChild(el);
  card = el;
  place(anchor, el);
  try {
    const s = await summaryFor(ref.kind, ref.workspace, ref.id);
    if (card !== el) return;
    el.innerHTML = ticketCardHtml(s);
  } catch (err) {
    if (card !== el) return;
    el.innerHTML = `<div class="ticket-card-id">${escapeHtml(ref.id)}</div><div class="ticket-card-error">${escapeHtml(String(err))}</div>`;
  }
  place(anchor, el);
}

// Hover-only: touch has no hover, and a tap on a ticket link just opens it.
const canHover = () => typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;

export function handleTicketHover(e: MouseEvent): void {
  const a = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!a || a === cardAnchor || !parseTicketUrl(a.href) || !canHover()) return;
  hideCard();
  cardAnchor = a;
  timer = setTimeout(() => void showCard(a), HOVER_DELAY_MS);
}

export function handleTicketHoverOut(e: MouseEvent): void {
  if (!cardAnchor) return;
  const to = e.relatedTarget as Node | null;
  if (to && cardAnchor.contains(to)) return;
  hideCard();
}
