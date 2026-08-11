// Snapshot-history rail for the preview panel (todo 583 split out of
// preview-panel.ts) - same deps-object pattern as preview-panel-more-menu.ts.

import { escapeHtml } from "../../shared/escape-html";
import { formatRelativeMinutes } from "../../shared/formatters";
import type { PreviewMeta } from "../../types/ipc.generated";

export interface PvHistoryDeps {
  getSnapshots: () => PreviewMeta[];
  getSelectedId: () => string | undefined;
  onSelect: (id: string) => void;
}

/** Past-tense relative time ("just now" / "5m ago"), reusing the shared
 *  forward-looking h/m breakdown for the math. */
function agoText(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  return formatRelativeMinutes(ms).replace(/^in /, "") + " ago";
}

function sourceDotClass(source: string): string {
  return source === "terminal" ? "pv-dot-terminal" : "pv-dot-chat";
}

/** Renders the `[data-rail]` markup from the current snapshot list; leaves
 *  the rail's `hidden` state (owned by the panel's historyOpen toggle) alone. */
export function renderPvRail(root: HTMLElement, deps: PvHistoryDeps): void {
  const rail = root.querySelector<HTMLElement>("[data-rail]");
  if (!rail) return;
  const snapshots = deps.getSnapshots();
  if (snapshots.length === 0) {
    rail.innerHTML = `<div class="pv-rail-lbl">History</div>`;
    return;
  }
  const liveId = snapshots[0]?.id;
  const selectedId = deps.getSelectedId();
  const rows = snapshots.map((s) => {
    const sel = selectedId === s.id ? " sel" : "";
    const liveTag = s.id === liveId ? ` <span class="pv-live-tag">LIVE</span>` : "";
    return `<div class="pv-snap${sel}" data-id="${escapeHtml(s.id)}">
      <div class="pv-snap-title">${escapeHtml(s.title || s.slug)}${liveTag}</div>
      <div class="pv-snap-meta"><span class="pv-dot ${sourceDotClass(s.source)}"></span>v${s.version} · ${agoText(s.created_at)}</div>
    </div>`;
  }).join("");
  rail.innerHTML = `<div class="pv-rail-lbl">History</div>${rows}`;
}

/** Wires snapshot-row clicks within `root`; safe to call alongside the
 *  panel's own click listener since both delegate off the same root. */
export function wirePvHistoryClicks(root: HTMLElement, deps: PvHistoryDeps): void {
  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const snap = target.closest<HTMLElement>(".pv-snap");
    if (snap?.dataset.id) deps.onSelect(snap.dataset.id);
  });
}
