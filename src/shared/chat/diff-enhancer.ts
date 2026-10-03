// Async post-pass that upgrades plain edit-window hunks (two monochrome
// <pre> sides) into a unified, syntax-highlighted diff: jsdiff aligns the
// lines (diff-rows.ts), shiki lays VS Code-grade token colors over
// translucent add/del line tints. Mirrors the code-highlighter.ts lifecycle:
// sync renderers emit fallback markup, this pass enhances it in place.
//
// Inline chat edit windows are default-collapsed <details>, so enhancement
// is lazy: armLazyDiffEnhance attaches one capture-phase toggle listener per
// chat container and enhances a window's hunks on first open.

import { loadShiki } from "./shiki-loader";
import { buildDiffRows, normalizeEol, type DiffRow } from "./diff-rows";
import { escapeHtml } from "../escape-html";

/** Per-side line cap: beyond this, skip tokenization (tints + gutter only). */
const MAX_TOKENIZE_LINES = 500;

// Extensions that aren't themselves shiki language ids/aliases.
const EXT_LANG_ALIASES: Record<string, string> = {
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  ps1: "powershell",
  psm1: "powershell",
  yml: "yaml",
  md: "markdown",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  h: "c",
  cc: "cpp",
  hpp: "cpp",
  htm: "html",
  conf: "ini",
  rakefile: "ruby",
};

export async function langForPath(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  const m = /\.([A-Za-z0-9_]+)$/.exec(path);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  const lang = EXT_LANG_ALIASES[ext] ?? ext;
  // An unbundled lang makes codeToTokens throw, so gate on the bundle index.
  const { bundledLanguages } = await loadShiki();
  return lang in bundledLanguages ? lang : null;
}

type TokenLine = { content: string; htmlStyle?: Record<string, string> }[];

async function tokenizeSide(text: string, lang: string): Promise<TokenLine[] | null> {
  try {
    const { codeToTokens, bundledLanguages } = await loadShiki();
    const result = await codeToTokens(text, {
      lang: lang as keyof typeof bundledLanguages,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    return result.tokens;
  } catch {
    return null;
  }
}

function styleAttr(htmlStyle: Record<string, string> | undefined): string {
  if (!htmlStyle) return "";
  const css = Object.entries(htmlStyle).map(([k, v]) => `${k}:${v}`).join(";");
  return css ? ` style="${escapeHtml(css)}"` : "";
}

/**
 * Serialize text pieces (shiki tokens, or one plain piece) to spans,
 * splitting pieces at emphasis-range boundaries so changed words get a
 * .diff-emph wrapper without nesting span soup: each emitted span carries
 * both the token style and (when in range) the emph class.
 */
function piecesToHtml(
  pieces: { content: string; htmlStyle?: Record<string, string> }[],
  ranges: [number, number][] | undefined,
): string {
  if (!ranges?.length) {
    return pieces
      .map((p) => `<span${styleAttr(p.htmlStyle)}>${escapeHtml(p.content)}</span>`)
      .join("");
  }
  let html = "";
  let off = 0;
  for (const p of pieces) {
    const start = off;
    const end = off + p.content.length;
    const cuts = new Set<number>([start, end]);
    for (const [a, b] of ranges) {
      if (a > start && a < end) cuts.add(a);
      if (b > start && b < end) cuts.add(b);
    }
    const sorted = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      const seg = p.content.slice(a - start, b - start);
      if (!seg) continue;
      const inEmph = ranges.some(([ra, rb]) => a >= ra && b <= rb);
      html += `<span${inEmph ? ' class="diff-emph"' : ""}${styleAttr(p.htmlStyle)}>${escapeHtml(seg)}</span>`;
    }
    off = end;
  }
  return html;
}

function rowHtml(row: DiffRow, tokens: TokenLine | undefined): string {
  const pieces = tokens ?? (row.text ? [{ content: row.text }] : []);
  const body = piecesToHtml(pieces, row.emph);
  // Zero-width space keeps empty rows from collapsing to zero height.
  return `<div class="diff-line diff-line--${row.kind}">${body || "&#8203;"}</div>`;
}

function copyButtonHtml(): string {
  return `<button class="copy-btn diff-copy-btn" aria-label="Copy new version"><i class="ph ph-copy"></i></button>`;
}

/** The post-edit file content = ctx + add rows, in order. */
export function newTextFromRows(rows: DiffRow[]): string {
  return rows.filter((r) => r.kind !== "del").map((r) => r.text).join("\n");
}

async function enhanceHunk(hunk: HTMLElement): Promise<void> {
  // Write's before side renders an "(new file)" label span with no <pre>;
  // a missing <pre> therefore reads as an empty side, never the label text.
  const oldRaw = hunk.querySelector('[data-side="before"] pre')?.textContent ?? "";
  const newRaw = hunk.querySelector('[data-side="after"] pre')?.textContent ?? "";
  const oldText = normalizeEol(oldRaw);
  const newText = normalizeEol(newRaw);
  const rows = buildDiffRows(oldText, newText);
  if (!rows) return; // diff too large - keep the plain two-pane fallback

  const path = hunk.closest<HTMLElement>("[data-path]")?.dataset.path;
  const lang = await langForPath(path);

  let oldTokens: TokenLine[] | null = null;
  let newTokens: TokenLine[] | null = null;
  if (lang) {
    const oldLines = oldText.split("\n").length;
    const newLines = newText.split("\n").length;
    if (rows.some((r) => r.kind === "del") && oldLines <= MAX_TOKENIZE_LINES) {
      oldTokens = await tokenizeSide(oldText, lang);
    }
    if (rows.some((r) => r.kind !== "del") && newLines <= MAX_TOKENIZE_LINES) {
      newTokens = await tokenizeSide(newText, lang);
    }
  }

  const pick = (row: DiffRow): TokenLine | undefined => {
    const side = row.kind === "del" ? oldTokens : newTokens;
    return side?.[row.srcLine];
  };
  const rowsHtml = rows.map((r) => rowHtml(r, pick(r))).join("");
  hunk.innerHTML = `<div class="diff-unified">${rowsHtml}</div>${copyButtonHtml()}`;

  const copyBtn = hunk.querySelector<HTMLButtonElement>(".diff-copy-btn");
  copyBtn?.addEventListener("click", () => {
    void navigator.clipboard.writeText(newTextFromRows(rows)).then(() => {
      copyBtn.classList.add("copied");
      const icon = copyBtn.querySelector("i");
      if (icon) icon.className = "ph ph-check";
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        if (icon) icon.className = "ph ph-copy";
      }, 1200);
    });
  });
}

export async function enhanceEditDiffs(container: HTMLElement): Promise<void> {
  const hunks = Array.from(
    container.querySelectorAll<HTMLElement>(".edit-window-hunk:not([data-enhanced])"),
  );
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (!hunk) continue;
    // Mark before the async work so concurrent passes never double-enhance.
    hunk.dataset.enhanced = "true";
    try {
      await enhanceHunk(hunk);
    } catch {
      // Tokenizer/diff blew up - the plain fallback markup stays usable.
    }
    // Same macrotask-yield pattern as highlightCodeBlocks: keep the UI
    // responsive when a message carries many hunks.
    if (i + 1 < hunks.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

/**
 * Arm a chat container so collapsed edit windows enhance on first open.
 * Idempotent per container; `toggle` doesn't bubble, hence capture phase.
 */
export function armLazyDiffEnhance(container: HTMLElement): void {
  if (container.dataset.diffEnhanceArmed) return;
  container.dataset.diffEnhanceArmed = "1";
  container.addEventListener(
    "toggle",
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (!t.classList.contains("edit-window") || !(t as HTMLDetailsElement).open) return;
      void enhanceEditDiffs(t);
    },
    true,
  );
}
