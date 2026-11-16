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

function panelHtml(entry: ChangelogEntry, entries: ChangelogEntry[]): string {
  const tabs = entries.length > 1
    ? `<div class="wn-tabs" role="tablist">${entries.map((e) => `<button type="button" role="tab" class="wn-tab${e.version === entry.version ? " is-active" : ""}" aria-selected="${e.version === entry.version}" data-wn="version" data-wn-version="${escapeHtml(e.version)}">v${escapeHtml(e.version)}</button>`).join("")}</div>`
    : "";
  return `<section class="wn-panel" aria-label="What's new">
    <header class="wn-head">
      <div class="wn-title"><i class="ph ph-sparkle"></i><h2>What's new in v${escapeHtml(entry.version)}</h2><span class="wn-date">${escapeHtml(dateLabel(entry.date))}</span></div>
      ${tabs}
      <button type="button" class="wn-close" data-wn="close" aria-label="Close what's new"><i class="ph ph-x"></i></button>
    </header>
    <div class="wn-grid">${entry.items.map(cardHtml).join("")}</div>
  </section>`;
}

/** Spends the pending flag once a panel is still attached after a moment, so
 *  the next launch starts closed. A draw that was replaced at once leaves the
 *  flag set and the panel opens on the next empty-state draw. */
function spendWhenSeen(): void {
  setTimeout(() => {
    if (document.querySelector(".wn-host .wn-panel")) clearPending();
  }, SEEN_AFTER_MS);
}

function innerHtml(entries: ChangelogEntry[]): string {
  const entry = shownEntry(entries);
  if (!entry) return "";
  if (!open && autoOpenWanted(entries)) {
    open = true;
    shownVersion = entry.version;
  }
  if (open) {
    // Every draw of the open panel while the flag is set may be the one that stays.
    if (autoOpenWanted(entries)) spendWhenSeen();
    return panelHtml(entry, entries);
  }
  // The button always names the newest entry, whatever tab was last looked at.
  const newest = latestEntry(entries) ?? entry;
  return `<button type="button" class="wn-btn" data-wn="open"><i class="ph ph-sparkle"></i><span>What's new</span><span class="wn-btn-ver">v${escapeHtml(newest.version)}</span></button>`;
}

/** Markup for the empty state's changelog block ("" when there are no entries).
 *  The host element stays put so a click re-renders only its own contents. */
export function whatsNewHtml(entries: ChangelogEntry[] = ENTRIES): string {
  if (entries.length === 0) return "";
  return `<div class="wn-host">${innerHtml(entries)}</div>`;
}

function refreshHosts(): void {
  document.querySelectorAll<HTMLElement>(".wn-host").forEach((host) => {
    host.innerHTML = innerHtml(ENTRIES);
  });
}

/** One document-level listener (the pane's markup is replaced wholesale, so
 *  per-element listeners would be lost) plus the update-detected refresh. */
export function setupWhatsNew(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>("[data-wn]");
    if (!el || !el.closest(".wn-host")) return;
    switch (el.dataset.wn) {
      // A click is a look: spend the flag so a later redraw cannot reopen what was just closed.
      case "open": open = true; shownVersion = latestEntry(ENTRIES)?.version ?? null; clearPending(); break;
      case "close": open = false; shownVersion = null; clearPending(); break;
      case "version": shownVersion = el.dataset.wnVersion ?? shownVersion; break;
      default: return;
    }
    refreshHosts();
  });
  window.addEventListener(PENDING_EVENT, refreshHosts);
}

// Installed on import: every window that can draw the empty state (main, chats,
// the phone page) imports sessions-helpers, so none needs its own boot call.
if (typeof document !== "undefined") setupWhatsNew();

/** Test seam: forget the in-memory panel state. */
export function resetWhatsNewForTests(): void {
  open = false;
  shownVersion = null;
}
