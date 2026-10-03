// HTML renderers for inline edit-window (chat) and stacked diff.
// Pure functions, return escaped HTML strings. Consumed by chat-transforms.ts.

import type { FileEditView, FileEditHunk } from "./file-edits";
import { escapeHtml } from "../escape-html";

const KIND_ICON: Record<FileEditView["kind"], string> = {
  edit: "ph-pencil-simple",
  write: "ph-file-plus",
  multi: "ph-stack",
  notebook: "ph-notebook",
};

function diffBadgeHtml(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`<span class="diff-add">+${added}</span>`);
  if (removed > 0) parts.push(`<span class="diff-del">-${removed}</span>`);
  if (parts.length === 0) parts.push(`<span class="diff-zero">±0</span>`);
  return `<span class="edit-window-diff">${parts.join(" ")}</span>`;
}

function hunkSideHtml(text: string, side: "before" | "after", emptyLabel?: string): string {
  if (text === "" && emptyLabel) {
    return `<div class="edit-window-side" data-side="${side}"><span class="edit-window-empty">${escapeHtml(emptyLabel)}</span></div>`;
  }
  return `<div class="edit-window-side" data-side="${side}"><pre>${escapeHtml(text)}</pre></div>`;
}

function hunkHtml(h: FileEditHunk, kind: FileEditView["kind"]): string {
  const labelHtml = h.label ? `<div class="edit-window-hunk-label">${escapeHtml(h.label)}</div>` : "";
  const beforeEmpty = kind === "write" ? "(new file)" : undefined;
  return `${labelHtml}<div class="edit-window-hunk">${hunkSideHtml(h.oldText, "before", beforeEmpty)}${hunkSideHtml(h.newText, "after")}</div>`;
}

export function renderEditWindow(view: FileEditView): string {
  const icon = KIND_ICON[view.kind];
  const summary = `<summary class="edit-window-summary"><i class="ph ${icon}"></i><span class="edit-window-path">${escapeHtml(view.basename)}</span>${diffBadgeHtml(view.addedLines, view.removedLines)}</summary>`;
  const body = `<div class="edit-window-body">${view.hunks.map((h) => hunkHtml(h, view.kind)).join("")}</div>`;
  return `<details class="edit-window" data-kind="${view.kind}" data-path="${escapeHtml(view.path)}">${summary}${body}</details>`;
}
