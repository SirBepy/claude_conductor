// The preview panel's two pickers: the name in the header opens the list of
// this chat's previews, and the version beside it opens the versions of the
// preview in view (Joe, 2026-10-30). Both share one PopoverShell, so opening
// one replaces the other.

import { escapeHtml } from "../../shared/escape-html";
import { formatRelativeMinutes } from "../../shared/formatters";
import { PopoverShell } from "./statusbar-popover-shell";
import type { PreviewMeta } from "../../types/ipc.generated";

export interface PvPickerDeps {
  /** This chat's previews, newest first. */
  getSnapshots: () => PreviewMeta[];
  getSelectedId: () => string | undefined;
  /** The archived version in view, or null for the latest. */
  getSelectedVersion: () => number | null;
  onSelectPreview: (id: string) => void;
  /** null picks the latest. */
  onSelectVersion: (version: number | null) => void;
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

/** A host on an older build lists previews with no `versions`, so a missing
 *  field means none are kept. */
export function versionsOf(meta: PreviewMeta): PreviewMeta["versions"] {
  return meta.versions ?? [];
}

type PickerKind = "previews" | "versions";

const shell = new PopoverShell();
let openKind: PickerKind | null = null;

export function closePvHistory(): void {
  shell.close();
}

function previewsHtml(deps: PvPickerDeps): string {
  const selectedId = deps.getSelectedId();
  const rows = deps.getSnapshots().map((s) => {
    const sel = selectedId === s.id ? " sel" : "";
    return `<button type="button" class="pv-snap${sel}" data-id="${escapeHtml(s.id)}">
      <div class="pv-snap-title">${escapeHtml(s.title || s.slug)}</div>
      <div class="pv-snap-meta"><span class="pv-dot ${sourceDotClass(s.source)}"></span>${agoText(s.created_at)}</div>
    </button>`;
  }).join("");
  return `<div class="pv-hist-lbl">Previews</div>${rows}`;
}

function versionsHtml(deps: PvPickerDeps): string {
  const meta = deps.getSnapshots().find((s) => s.id === deps.getSelectedId());
  if (!meta) return `<div class="pv-hist-lbl">Versions</div><div class="pv-hist-empty">No other versions yet.</div>`;
  const selected = deps.getSelectedVersion();
  const row = (label: string, iso: string, version: number | null) => {
    const sel = selected === version ? " sel" : "";
    return `<button type="button" class="pv-snap${sel}" data-version="${version ?? ""}">
      <div class="pv-snap-title">${label}</div>
      <div class="pv-snap-meta">${agoText(iso)}</div>
    </button>`;
  };
  const rows = [row("Latest", meta.created_at, null), ...versionsOf(meta).map((v) => row(`v${v.version}`, v.created_at, v.version))];
  return `<div class="pv-hist-lbl">Versions</div>${rows.join("")}`;
}

/** Picking a row closes the popover, since the choice is made. */
export function togglePvPicker(kind: PickerKind, anchor: HTMLElement, deps: PvPickerDeps): void {
  if (shell.isOpen && openKind === kind) {
    shell.close();
    return;
  }
  openKind = kind;
  shell.open(anchor, kind === "previews" ? previewsHtml(deps) : versionsHtml(deps), {
    className: "pv-history-popover",
    onClose: () => { openKind = null; },
    wire: (el) => {
      el.addEventListener("click", (e) => {
        const snap = (e.target as HTMLElement).closest<HTMLElement>(".pv-snap");
        if (!snap) return;
        if (kind === "previews") {
          if (!snap.dataset.id) return;
          deps.onSelectPreview(snap.dataset.id);
        } else {
          deps.onSelectVersion(snap.dataset.version ? Number(snap.dataset.version) : null);
        }
        shell.close();
      });
    },
  });
}
