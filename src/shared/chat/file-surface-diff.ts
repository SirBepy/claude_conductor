// Unified-git-diff parsing + rendering for the file surface (ai_todo 247),
// split out of file-surface.ts: a self-contained subsystem with no
// dependency on the surface's state beyond the parsed hunks it returns.
// Also backs the session-edit "Side by side" view (ai_todo 245): FileEditView
// hunks convert into this same DiffRow model so one renderer + one shiki
// highlight pass serves both sources.

import { escapeHtml } from "../escape-html";
import { loadShiki } from "./shiki-loader";
import { buildDiffRows as alignLines, normalizeEol } from "./diff-rows";
import type { FileEditView } from "./file-edits";

export type DiffRowKind = "add" | "del" | "ctx" | "hunk";
export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

// Parse a unified git diff (for a single file) into rows. Header noise before
// the first hunk ("diff --git", "index ...", "--- a/...", "+++ b/...") is
// skipped; everything else is read off the "@@ -a,b +c,d @@" hunk headers.
export function parseUnifiedDiff(diffText: string): DiffRow[] {
  const rawLines = diffText.split(/\r?\n/);
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const rows: DiffRow[] = [];
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of rawLines) {
    const m = hunkRe.exec(raw);
    if (m) {
      oldLine = parseInt(m[1] ?? "0", 10);
      newLine = parseInt(m[2] ?? "0", 10);
      inHunk = true;
      rows.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw.slice(1), newLine });
      newLine++;
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw.slice(1), oldLine });
      oldLine++;
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      rows.push({ kind: "ctx", text, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  return rows;
}

// Converts a session's accrued FileEditView entries into the same row model
// parseUnifiedDiff produces, so the split renderer + shiki pass need no
// source-specific branching. No real line numbers exist for a raw old/new
// string pair, so oldLine/newLine stay unset (gutter renders blank).
const EDIT_KIND_LABEL: Record<FileEditView["kind"], string> = {
  edit: "Edit",
  write: "Write",
  multi: "Multi-edit",
  notebook: "Notebook edit",
};

export function sessionEditsToDiffRows(views: FileEditView[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const view of views) {
    rows.push({ kind: "hunk", text: `${EDIT_KIND_LABEL[view.kind]} · +${view.addedLines} -${view.removedLines}` });
    for (const hunk of view.hunks) {
      if (hunk.label) rows.push({ kind: "hunk", text: hunk.label });
      const oldText = normalizeEol(hunk.oldText);
      const newText = normalizeEol(hunk.newText);
      const aligned = alignLines(oldText, newText);
      if (!aligned) {
        // Diff too large for jsdiff's bound - show whole sides, still one row
        // per physical line so the single-line DiffRow shape holds.
        if (oldText) for (const line of oldText.split("\n")) rows.push({ kind: "del", text: line });
        if (newText) for (const line of newText.split("\n")) rows.push({ kind: "add", text: line });
        continue;
      }
      for (const r of aligned) rows.push({ kind: r.kind, text: r.text });
    }
  }
  return rows;
}

export function renderUnifiedDiffHtml(rows: DiffRow[]): string {
  const trs = rows
    .map((r, i) => {
      if (r.kind === "hunk") {
        return `<tr class="fs-hunk"><td colspan="4">${escapeHtml(r.text)}</td></tr>`;
      }
      const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
      const oldCell = r.oldLine !== undefined ? String(r.oldLine) : "";
      const newCell = r.newLine !== undefined ? String(r.newLine) : "";
      const codeText = r.text.length ? escapeHtml(r.text) : "&#8203;";
      return (
        `<tr class="fs-${r.kind}">` +
        `<td class="fs-ln" data-no-search="1">${oldCell}</td>` +
        `<td class="fs-ln" data-no-search="1">${newCell}</td>` +
        `<td class="fs-sign" data-no-search="1">${sign}</td>` +
        `<td class="fs-code" data-ri="${i}">${codeText}</td></tr>`
      );
    })
    .join("");
  return `<table class="fs-udiff">${trs}</table>`;
}

export function renderSplitDiffHtml(rows: DiffRow[]): string {
  const left: string[] = [];
  const right: string[] = [];
  const rowDiv = (line: number | undefined, text: string, cls: string, ri: number): string =>
    `<div class="fs-srow ${cls}"><span class="fs-ln" data-no-search="1">${line ?? ""}</span>` +
    `<span class="fs-code" data-ri="${ri}">${text.length ? escapeHtml(text) : "&#8203;"}</span></div>`;
  const padDiv = (): string =>
    `<div class="fs-srow fs-pad"><span class="fs-ln" data-no-search="1"></span><span class="fs-code"></span></div>`;
  rows.forEach((r, i) => {
    if (r.kind === "hunk") {
      left.push(`<div class="fs-hunk">${escapeHtml(r.text)}</div>`);
      right.push(`<div class="fs-hunk">&nbsp;</div>`);
      return;
    }
    if (r.kind === "ctx") {
      left.push(rowDiv(r.oldLine, r.text, "", i));
      right.push(rowDiv(r.newLine, r.text, "", i));
    } else if (r.kind === "del") {
      left.push(rowDiv(r.oldLine, r.text, "fs-del", i));
      right.push(padDiv());
    } else {
      left.push(padDiv());
      right.push(rowDiv(r.newLine, r.text, "fs-add", i));
    }
  });
  return `<div class="fs-sdiff"><div class="fs-side">${left.join("")}</div><div class="fs-side">${right.join("")}</div></div>`;
}

// ── syntax highlighting (lazy post-pass, mirrors diff-enhancer.ts's one-call-
// per-side batching so this never falls back to a slow per-line codeToHtml
// loop) ──────────────────────────────────────────────────────────────────

const MAX_HIGHLIGHT_LINES = 800;

// Shiki wraps each source line in <span class="line">; parsing that back out
// gives per-row HTML without a second codeToHtml call per line.
function splitShikiLines(html: string): string[] {
  if (!html) return [];
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return Array.from(holder.querySelectorAll(".line")).map((line) => line.innerHTML);
}

export interface DiffHighlightMaps {
  old: Map<DiffRow, string>;
  new: Map<DiffRow, string>;
}

// One codeToHtml call for the old-side lines, one for the new-side lines
// (ctx lines appear in both). Single theme (github-dark), same as
// renderFileView - inline colors only, no CSS var dependency.
export async function highlightDiffRows(rows: DiffRow[], lang: string): Promise<DiffHighlightMaps | null> {
  const oldRows = rows.filter((r) => r.kind === "del" || r.kind === "ctx");
  const newRows = rows.filter((r) => r.kind === "add" || r.kind === "ctx");
  if (!oldRows.length && !newRows.length) return null;
  if (oldRows.length > MAX_HIGHLIGHT_LINES || newRows.length > MAX_HIGHLIGHT_LINES) return null;
  try {
    const { codeToHtml } = await loadShiki();
    const oldText = oldRows.map((r) => r.text).join("\n");
    const newText = newRows.map((r) => r.text).join("\n");
    const [oldHtml, newHtml] = await Promise.all([
      oldText ? codeToHtml(oldText, { lang, theme: "github-dark" }) : Promise.resolve(""),
      newText ? codeToHtml(newText, { lang, theme: "github-dark" }) : Promise.resolve(""),
    ]);
    const oldLines = splitShikiLines(oldHtml);
    const newLines = splitShikiLines(newHtml);
    const old = new Map<DiffRow, string>();
    const neu = new Map<DiffRow, string>();
    oldRows.forEach((r, i) => old.set(r, oldLines[i] || (r.text ? escapeHtml(r.text) : "&#8203;")));
    newRows.forEach((r, i) => neu.set(r, newLines[i] || (r.text ? escapeHtml(r.text) : "&#8203;")));
    return { old, new: neu };
  } catch {
    return null;
  }
}

function indexCellsByRi(scope: Element): Map<number, HTMLElement> {
  const cells = new Map<number, HTMLElement>();
  for (const cell of Array.from(scope.querySelectorAll<HTMLElement>(".fs-code[data-ri]"))) {
    const ri = Number(cell.dataset.ri);
    if (!Number.isNaN(ri)) cells.set(ri, cell);
  }
  return cells;
}

function applyMapToScope(scope: Element, rows: DiffRow[], map: Map<DiffRow, string>): void {
  const cells = indexCellsByRi(scope);
  rows.forEach((row, i) => {
    const html = map.get(row);
    const cell = cells.get(i);
    if (html !== undefined && cell) cell.innerHTML = html;
  });
}

// Applies highlighted markup in place over already-rendered plain markup
// (renderUnifiedDiffHtml or renderSplitDiffHtml output), keyed by data-ri.
export function applyDiffHighlight(container: HTMLElement, rows: DiffRow[], maps: DiffHighlightMaps): void {
  const [left, right] = Array.from(container.querySelectorAll<HTMLElement>(".fs-side"));
  if (left && right) {
    applyMapToScope(left, rows, maps.old);
    applyMapToScope(right, rows, maps.new);
    return;
  }
  const cells = indexCellsByRi(container);
  rows.forEach((row, i) => {
    if (row.kind === "hunk") return;
    const map = row.kind === "del" ? maps.old : maps.new;
    const html = map.get(row);
    const cell = cells.get(i);
    if (html !== undefined && cell) cell.innerHTML = html;
  });
}
