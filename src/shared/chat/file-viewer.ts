// Unified in-app file screen (ai_todo 95). One destination for "look at / work
// on a file" opened from in-chat Read / File-Changes rows and the statusbar
// tool-tally Files rows. Thin standalone host: overlay + near-fullscreen
// panel with a filename header, wrapping ONE shared file surface
// (./file-surface.ts) which owns every mode (File / Diff / Edit), the ⋮ menu,
// search, and the "Open in VS Code" action. Same component the future PR
// review file tabs will mount (see .for_bepy/pr-review-mockup.html).

import { basename } from "../path-utils";
import { escapeHtml } from "../escape-html";
import { createFileSurface, type FileSurfaceHandle, type SurfaceFile } from "./file-surface";
import type { FileEditView } from "./file-edits";

let overlay: HTMLDivElement | null = null;
let surface: FileSurfaceHandle | null = null;

// The active session's accrued file edits, registered by the sessions view so
// the Diff view can resolve "this file's changes" from any entry point
// without threading them through every call site.
let editsProvider: (() => FileEditView[]) | null = null;
export function setFileEditsProvider(fn: (() => FileEditView[]) | null): void {
  editsProvider = fn;
}

function diffTotals(edits: FileEditView[]): { added: number; removed: number } {
  return edits.reduce(
    (acc, e) => ({ added: acc.added + e.addedLines, removed: acc.removed + e.removedLines }),
    { added: 0, removed: 0 },
  );
}

export function openFileViewer(path: string): void {
  closeFileViewer();

  const edits = (editsProvider?.() ?? []).filter((e) => e.path === path);
  const { added, removed } = diffTotals(edits);
  const file: SurfaceFile = {
    path,
    added,
    removed,
    sessionEdits: edits.length > 0 ? edits : undefined,
  };

  overlay = document.createElement("div");
  overlay.className = "file-viewer-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFileViewer();
  });

  const panel = document.createElement("div");
  panel.className = "file-viewer-panel";
  panel.appendChild(buildHeader(path));

  const body = document.createElement("div");
  body.className = "file-viewer-body";
  panel.appendChild(body);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKeydown);

  surface = createFileSurface(body, {
    // Opened from a single file (a chat Read row / tool-tally row): no
    // sibling set to step through.
    nav: null,
    defaultView: edits.length > 0 ? "diff" : "file",
  });
  surface.show(file);
}

function buildHeader(path: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "file-viewer-header";
  const name = basename(path);
  header.innerHTML =
    `<div class="file-viewer-title" title="${escapeHtml(path)}">` +
    `<i class="ph ph-file-text"></i>` +
    `<span class="file-viewer-name">${escapeHtml(name)}</span>` +
    `<span class="file-viewer-path">${escapeHtml(path)}</span>` +
    `</div>` +
    `<button class="icon-btn-sq file-viewer-close" type="button" aria-label="Close">` +
    `<i class="ph ph-x"></i>` +
    `</button>`;
  header.querySelector<HTMLButtonElement>(".file-viewer-close")?.addEventListener("click", closeFileViewer);
  return header;
}

export function closeFileViewer(): void {
  if (!overlay) return;
  surface?.destroy();
  surface = null;
  overlay.remove();
  overlay = null;
  document.removeEventListener("keydown", onKeydown);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    closeFileViewer();
    return;
  }
  surface?.handleKey(e);
}
