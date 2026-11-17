// The "What's new" block on the empty session screen: a button, and under it
// (open) a card grid of pictures with a title and one line each. Part of
// paneEmptyStateHtml, so every surface that draws the empty state gets it.
import "./whats-new.css";
import { ENTRIES, type ChangelogEntry } from "../../../changelog/entries";
import { escapeHtml } from "../../../shared/escape-html";
import { autoOpenWanted, clearPending, latestEntry, PENDING_EVENT } from "./whats-new-state";

// Module state, not DOM state: the empty state is re-rendered whole when the
// daemon connects or stalls, and the open panel must survive that.
let open = false;
let shownVersion: string | null = null;
let installed = false;
// True from the moment the panel is opened until its first paint is done, so
// only that one draw carries `is-opening` (the grow-in). Every later redraw of
// the open panel (daemon change, tab switch) is drawn without it and stays still.
let opening = false;
let spendTimer: ReturnType<typeof setTimeout> | null = null;

/** How long an auto-opened panel must stay on screen before the pending flag
 *  is spent. The empty state is often drawn for a moment and replaced (the last
 *  chat is restored right after the daemon connects); spending the flag on that
 *  draw would lose the changelog the user never saw. */
export const SEEN_AFTER_MS = 500;

function shownEntry(entries: ChangelogEntry[]): ChangelogEntry | null {
  return entries.find((e) => e.version === shownVersion) ?? latestEntry(entries);
}

function dateLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function cardHtml(item: ChangelogEntry["items"][number]): string {
  return `<article class="wn-card">
    <img class="wn-shot" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.alt)}" loading="lazy">
    <div class="wn-card-body">
      <i class="ph ${escapeHtml(item.icon)} wn-card-icon"></i>
      <h3 class="wn-card-title">${escapeHtml(item.title)}</h3>
      <p class="wn-card-caption">${escapeHtml(item.caption)}</p>
    </div>
  </article>`;
}

// Fixed ids: one empty screen exists per document, and the opener, the close
// button and the tabs all point at these through aria-controls.
const PANEL_ID = "wn-panel";
const TABPANEL_ID = "wn-tabpanel";
const tabId = (version: string): string => `wn-tab-${version.replace(/[^\w-]/g, "_")}`;

function panelHtml(entry: ChangelogEntry, entries: ChangelogEntry[]): string {
  const tabbed = entries.length > 1;
  // Roving tabindex: only the selected tab is in the Tab order, arrows move between tabs.
  const tabs = tabbed
    ? `<div class="wn-tabs" role="tablist" aria-label="Releases">${entries.map((e) => {
      const active = e.version === entry.version;
      return `<button type="button" role="tab" id="${tabId(e.version)}" class="wn-tab${active ? " is-active" : ""}" aria-selected="${active}" aria-controls="${TABPANEL_ID}" tabindex="${active ? 0 : -1}" data-wn="version" data-wn-version="${escapeHtml(e.version)}">v${escapeHtml(e.version)}</button>`;
    }).join("")}</div>`
    : "";
  const gridAttrs = tabbed ? ` role="tabpanel" aria-labelledby="${tabId(entry.version)}"` : "";
  return `<section class="wn-panel${opening ? " is-opening" : ""}" id="${PANEL_ID}" aria-label="What's new">
    <header class="wn-head">
      <div class="wn-title"><i class="ph ph-sparkle"></i><h2>What's new in v${escapeHtml(entry.version)}</h2><span class="wn-date">${escapeHtml(dateLabel(entry.date))}</span></div>
      ${tabs}
      <button type="button" class="wn-close" data-wn="close" aria-label="Close what's new"><i class="ph ph-x"></i></button>
    </header>
    <div class="wn-grid" id="${TABPANEL_ID}"${gridAttrs}>${entry.items.map(cardHtml).join("")}</div>
  </section>`;
}

/** Spends the pending flag once a panel is still attached after a moment, so
 *  the next launch starts closed. A draw that was replaced at once leaves the
 *  flag set and the panel opens on the next empty-state draw. */
function spendWhenSeen(): void {
  // One timer, restarted by every draw: a draw that was replaced must not let
  // its successor be counted as seen for the full wait.
  if (spendTimer !== null) clearTimeout(spendTimer);
  spendTimer = setTimeout(() => {
    spendTimer = null;
    // A hidden window (tray, minimized) has not shown the panel to anyone.
    if (document.visibilityState === "hidden") return;
    if (document.querySelector(".wn-host .wn-panel")) clearPending();
  }, SEEN_AFTER_MS);
}

/** The grow-in belongs to the draw that opened the panel: once that draw has
 *  been painted, the next one is drawn without `is-opening`. */
function clearOpeningAfterPaint(): void {
  requestAnimationFrame(() => requestAnimationFrame(() => { opening = false; }));
}

function innerHtml(entries: ChangelogEntry[]): string {
  const entry = shownEntry(entries);
  if (!entry) return "";
  if (!open && autoOpenWanted(entries)) {
    open = true;
    opening = true;
    shownVersion = entry.version;
  }
  if (open) {
    // Every draw of the open panel while the flag is set may be the one that stays.
    if (autoOpenWanted(entries)) spendWhenSeen();
    const html = panelHtml(entry, entries);
    if (opening) clearOpeningAfterPaint();
    return html;
  }
  // The button always names the newest entry, whatever tab was last looked at.
  const newest = latestEntry(entries) ?? entry;
  return `<button type="button" class="wn-btn" data-wn="open" aria-expanded="false" aria-controls="${PANEL_ID}"><i class="ph ph-sparkle"></i><span>What's new</span><span class="wn-btn-ver">v${escapeHtml(newest.version)}</span></button>`;
}

/** Markup for the empty state's changelog block ("" when there are no entries).
 *  The host element stays put so a click re-renders only its own contents. */
export function whatsNewHtml(entries: ChangelogEntry[] = ENTRIES): string {
  if (entries.length === 0) return "";
  return `<div class="wn-host">${innerHtml(entries)}</div>`;
}

/** Where keyboard focus lands after a redraw that replaced the control the
 *  user was on (replacing innerHTML drops focus to the body otherwise). */
type FocusTarget = "close" | "open" | { tab: string };

function refreshHosts(refocus?: { host: HTMLElement; target: FocusTarget }): void {
  // A redraw nobody asked focus for (the update event, a daemon-driven repaint)
  // still keeps the user on the control they were on.
  if (!refocus) {
    const active = document.activeElement as HTMLElement | null;
    const host = active?.closest<HTMLElement>(".wn-host") ?? null;
    if (active && host) {
      if (active.dataset.wn === "open") refocus = { host, target: "open" };
      else if (active.dataset.wn === "close") refocus = { host, target: "close" };
      else if (active.dataset.wn === "version") refocus = { host, target: { tab: active.dataset.wnVersion ?? "" } };
    }
  }
  document.querySelectorAll<HTMLElement>(".wn-host").forEach((host) => {
    host.innerHTML = innerHtml(ENTRIES);
  });
  if (!refocus || !refocus.host.isConnected) return;
  const t = refocus.target;
  const sel = t === "close" ? ".wn-close" : t === "open" ? ".wn-btn" : `#${tabId(t.tab)}`;
  refocus.host.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
}

/** The version a tablist key moves to (arrows wrap, Home/End jump), or null for any other key. */
function tabKeyTarget(el: HTMLElement, key: string): string | null {
  const tabs = [...(el.closest(".wn-tabs")?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])];
  const at = tabs.indexOf(el);
  if (at < 0) return null;
  const next = key === "ArrowRight" ? (at + 1) % tabs.length
    : key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
    : key === "Home" ? 0
    : key === "End" ? tabs.length - 1
    : -1;
  return next < 0 ? null : tabs[next]!.dataset.wnVersion ?? null;
}

/** One document-level listener (the pane's markup is replaced wholesale, so
 *  per-element listeners would be lost) plus the update-detected refresh. */
export function setupWhatsNew(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>("[data-wn]");
    if (!el || !el.closest(".wn-host")) return;
    const host = el.closest<HTMLElement>(".wn-host")!;
    let target: FocusTarget;
    switch (el.dataset.wn) {
      // A click is a look: spend the flag so a later redraw cannot reopen what was just closed.
      case "open": open = true; opening = true; shownVersion = latestEntry(ENTRIES)?.version ?? null; clearPending(); target = "close"; break;
      case "close": open = false; opening = false; shownVersion = null; clearPending(); target = "open"; break;
      case "version": shownVersion = el.dataset.wnVersion ?? shownVersion; target = { tab: shownVersion ?? "" }; break;
      default: return;
    }
    refreshHosts({ host, target });
  });
  document.addEventListener("keydown", (e) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>("[role='tab'][data-wn='version']");
    if (!el || !el.closest(".wn-host")) return;
    // Alt+Arrow is the browser's back/forward and Ctrl+Home/End scroll the page: not ours.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const version = tabKeyTarget(el, e.key);
    if (version === null) return;
    e.preventDefault();
    shownVersion = version;
    refreshHosts({ host: el.closest<HTMLElement>(".wn-host")!, target: { tab: version } });
  });
  // Wrapped: the listener receives the Event, which refreshHosts would read as a refocus request.
  window.addEventListener(PENDING_EVENT, () => refreshHosts());
  // A panel drawn while the window was hidden is seen when the window shows:
  // nothing redraws it then, so the wait restarts here.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && autoOpenWanted(ENTRIES) && document.querySelector(".wn-host .wn-panel")) spendWhenSeen();
  });
}

// Installed on import: every window that can draw the empty state (main, chats,
// the phone page) imports sessions-helpers, so none needs its own boot call.
if (typeof document !== "undefined") setupWhatsNew();

/** Test seam: forget the in-memory panel state. */
export function resetWhatsNewForTests(): void {
  open = false;
  opening = false;
  shownVersion = null;
  if (spendTimer !== null) clearTimeout(spendTimer);
  spendTimer = null;
}
