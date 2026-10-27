// Ticket mentions in chat: ids in a message become links to the ticket (for a
// chat whose project has a tracker, see src-tauri/src/tickets.rs), and hovering
// any ticket link - ours or one Claude wrote as markdown - shows a small card
// with its title, state, owner and type. Tokens stay in the backend; this only
// ever sees the summary.

import { invoke } from "../ipc";
import { escapeHtml } from "../escape-html";
import { isRemote } from "../transport";
import type { TicketSummary, TrackerInfo, TrackerKind } from "../../types/ipc.generated";

// Registry env name per tracker kind - mirrors src-tauri/src/api_keys.rs's
// REGISTRY and the error text tickets.rs::token_for formats when unset
// ("{key} is not set in ~/.claude/.env"), so a missing-token error can offer
// the right modal instead of a dead-end message.
const TOKEN_ENV_FOR_KIND: Record<Exclude<TrackerKind, "off">, string> = {
  shortcut: "SHORTCUT_API_TOKEN",
  linear: "LINEAR_API_KEY",
};

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

// A bare Shortcut number: 5-6 digits standing alone, so not part of a decimal,
// a thousands-grouped count, a port (`:27183`), an assignment, a path or money.
// A leading comma only reads as a thousands separator when exactly 3 digits
// follow it (`12,345`); `12345,67890` is two ids, so the lookahead only blocks
// a 3-digit trailing group, and the lookbehind lets a comma through when the
// run right before it is itself a 5-6 digit id.
const BARE_SHORTCUT = /(?:(?<![\w/.,:=$-])|(?<=\d{5,6},))\d{5,6}(?![\w-]|[.:]\d|,\d{3}(?!\d))/g;

// A bare number is also an Amplitude project id, a build number, an account id,
// so it only links once the tracker confirms the story. true = exists, false =
// the tracker said 404 (cached so a re-rendered bubble never asks again).
// A transient failure (no token, offline) is left out so a later render retries.
const bareStory = new Map<string, boolean>();
const bareKey = (t: Pick<TrackerInfo, "workspace">, n: string) => `${t.workspace}/${n}`;

// Lookups started per render; the rest settle on a later render so a message
// full of numbers cannot fan out into one API call each.
const BARE_LOOKUPS_PER_RENDER = 5;

/** Forgets confirmed/missing bare-number answers (tests, tracker change). */
export function forgetBareStories(): void {
  bareStory.clear();
}

/** Hits whose answer is not known yet are skipped by `link`, and their numbers returned. */
function linkMatches(
  root: HTMLElement,
  re: RegExp,
  skip: string,
  t: TrackerInfo,
  idOf: (m: string) => string,
  link: (m: string) => boolean = () => true,
  pending?: Set<string>,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
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
      if (!link(m[0])) {
        pending?.add(m[0]);
        continue;
      }
      frag.append(text.slice(last, m.index), anchorFor(t, idOf(m[0])));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** Wraps ticket ids in `root`'s text in links. Skips existing links and code
 *  blocks. A bare 5-6 digit Shortcut number (in prose, or as a whole inline
 *  `55411` span, since code is full of ports and sizes) links only when the
 *  tracker already confirmed that story; the numbers still unconfirmed are
 *  returned for the caller to look up. */
export function applyTicketLinks(root: HTMLElement, t: TrackerInfo): string[] {
  const re = idPattern(t);
  if (!re) return [];
  const skip = "a, pre, .ticket-ref, .commit-ref";
  const pending = new Set<string>();
  linkMatches(root, re, skip, t, (m) => (t.kind === "shortcut" ? m.toLowerCase() : m));
  if (t.kind === "shortcut") {
    const confirmed = (n: string) => bareStory.get(bareKey(t, n)) === true;
    linkMatches(root, BARE_SHORTCUT, `${skip}, code`, t, (m) => m, confirmed, pending);
    root.querySelectorAll<HTMLElement>("code").forEach((code) => {
      if (code.closest("pre, a") || code.children.length > 0) return;
      const txt = code.textContent ?? "";
      if (!/^\d{5,6}$/.test(txt)) return;
      if (confirmed(txt)) code.replaceChildren(anchorFor(t, txt));
      else if (!bareStory.has(bareKey(t, txt))) pending.add(txt);
    });
  }
  return [...pending].filter((n) => !bareStory.has(bareKey(t, n)));
}

async function confirmBare(t: TrackerInfo, n: string): Promise<void> {
  try {
    await summaryFor(t.kind, t.workspace, `sc-${n}`);
    bareStory.set(bareKey(t, n), true);
  } catch (err) {
    if (String(err instanceof Error ? err.message : err).includes("404")) bareStory.set(bareKey(t, n), false);
  }
}

export async function linkifyTickets(root: HTMLElement, cwd: string | undefined): Promise<void> {
  if (!cwd) return;
  const known = trackers.get(cwd);
  const t = known !== undefined ? known : await trackerFor(cwd);
  if (!t || !root.isConnected) return;
  const pending = applyTicketLinks(root, t);
  if (pending.length === 0) return;
  await Promise.all(pending.slice(0, BARE_LOOKUPS_PER_RENDER).map((n) => confirmBare(t, n)));
  if (root.isConnected) applyTicketLinks(root, t);
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
    const msg = err instanceof Error ? err.message : String(err);
    // parseTicketUrl only ever returns "shortcut"/"linear" (the regexes above
    // match those two URL shapes only) - "off" is a TrackerKind value this
    // function can't produce, so the lookup below is always defined in
    // practice; the guard keeps the registry type honest regardless.
    const envName = ref.kind === "off" ? undefined : TOKEN_ENV_FOR_KIND[ref.kind];
    // Only the backend's own missing-token wording (tickets.rs::token_for)
    // gets the "Add key" action - any other failure (network, bad id, rate
    // limit) is just an error, nothing a key modal would fix.
    const missingToken = !isRemote() && !!envName && msg.includes(`${envName} is not set`);
    el.innerHTML = `<div class="ticket-card-id">${escapeHtml(ref.id)}</div><div class="ticket-card-error">${escapeHtml(msg)}</div>${missingToken ? `<button type="button" class="ticket-card-add-key-btn"><i class="ph ph-key"></i> Add key</button>` : ""}`;
    if (missingToken && envName) {
      el.querySelector<HTMLButtonElement>(".ticket-card-add-key-btn")?.addEventListener("click", () => {
        void (async () => {
          const { openApiKeyModal } = await import("../api-key-modal");
          const saved = await openApiKeyModal(envName);
          // Retry the summary once the key is in, so the card updates itself
          // instead of leaving the stale error up until the next hover.
          if (saved && card === el) void showCard(anchor);
        })();
      });
    }
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
