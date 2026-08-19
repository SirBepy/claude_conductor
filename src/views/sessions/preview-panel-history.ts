// Snapshot history for the preview panel (todo 583, reworked for todo 692).
// Was a 132px sidebar rail plus a "Show history" kebab item; both are gone.
// The version number now toggles this PopoverShell instead.

import { escapeHtml } from "../../shared/escape-html";
import { formatRelativeMinutes } from "../../shared/formatters";
import { PopoverShell } from "./statusbar-popover-shell";
import type { PreviewMeta } from "../../types/ipc.generated";

export interface PvHistoryDeps {
  getSnapshots: () => PreviewMeta[];
  getSelectedId: () => string | undefined;
  onSelect: (id: string) => void;
}

/** Past-tense relative time, reusing the shared forward-looking h/m breakdown.
 *  Exported because the Todos panel needs identical formatting on its cards. */
export function agoText(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  return formatRelativeMinutes(ms).replace(/^in /, "") + " ago";
}

function sourceDotClass(source: string): string {
  return source === "terminal" ? "pv-dot-terminal" : "pv-dot-chat";
}

const shell = new PopoverShell();

export function isPvHistoryOpen(): boolean {
  return shell.isOpen;
}

export function closePvHistory(): void {
  shell.close();
}

function historyHtml(deps: PvHistoryDeps): string {
  const snapshots = deps.getSnapshots();
  if (snapshots.length === 0) {
    return `<div class="pv-hist-lbl">History</div><div class="pv-hist-empty">No other versions yet.</div>`;
  }
  const liveId = snapshots[0]?.id;
  const selectedId = deps.getSelectedId();
  const rows = snapshots.map((s) => {
    const sel = selectedId === s.id ? " sel" : "";
    const liveTag = s.id === liveId ? ` <span class="pv-live-tag">LIVE</span>` : "";
    return `<button type="button" class="pv-snap${sel}" data-id="${escapeHtml(s.id)}">
      <div class="pv-snap-title">${escapeHtml(s.title || s.slug)}${liveTag}</div>
      <div class="pv-snap-meta"><span class="pv-dot ${sourceDotClass(s.source)}"></span>v${s.version} · ${agoText(s.created_at)}</div>
    </button>`;
  }).join("");
  return `<div class="pv-hist-lbl">History</div>${rows}`;
}

/** Picking a snapshot closes it, since the choice is made. */
export function togglePvHistory(anchor: HTMLElement, deps: PvHistoryDeps): void {
  if (shell.isOpen) {
    shell.close();
    return;
  }
  shell.open(anchor, historyHtml(deps), {
    className: "pv-history-popover",
    wire: (el) => {
      el.addEventListener("click", (e) => {
        const snap = (e.target as HTMLElement).closest<HTMLElement>(".pv-snap");
        if (!snap?.dataset.id) return;
        deps.onSelect(snap.dataset.id);
        shell.close();
      });
    },
  });
}
