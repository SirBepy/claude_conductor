// Code mode's editor body: a breadcrumb line (path, +/- counts, search) over a
// File or Diff view, with its controls rendered icon-only into a host the
// caller places (Code mode puts them at the right end of its tab row, VS
// Code's editor-title spot). Read-only. Styles in file-surface.css.

import { invoke } from "../ipc";
import { basename } from "../path-utils";
import { escapeHtml } from "../escape-html";
import { isRemote } from "../transport";
// REUSE the existing full Shiki build (same highlighter the chat diffs use),
// loaded lazily via shiki-loader (see its header comment) so it's not in the
// main bundle at boot. The /web bundle lacks rust/toml/etc grammars, so the
// lazy import MUST stay /bundle/full.
import { loadShiki } from "./shiki-loader";
import {
  parseUnifiedDiff,
  renderUnifiedDiffHtml,
  renderSplitDiffHtml,
  sessionEditsToDiffRows,
  highlightDiffRows,
  applyDiffHighlight,
  type DiffRow,
  type DiffHighlightMaps,
} from "./file-surface-diff";
import type { FileEditView } from "./file-edits";
import type { TextFileData } from "../../types/ipc.generated";

export interface SurfaceFile {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** Absolute path for Open in VS Code. Defaults to `path`. */
  absPath?: string;
  added?: number;
  removed?: number;
  // Diff sources - at most one is set:
  sessionEdits?: FileEditView[];
  /** Raw unified git diff text; `full` asks for the whole file as context. */
  gitDiff?: (opts: { full: boolean }) => Promise<string>;
  /** The file's content for the File view (a past revision, or the working tree). */
  fileAtRev: () => Promise<TextFileData>;
}

export interface FileSurfaceOptions {
  defaultView: "diff" | "file";
  /** Where the icon-only controls render. Without one they sit at the end of
   *  the breadcrumb line. */
  toolsHost?: HTMLElement;
}

export interface FileSurfaceHandle {
  show(file: SurfaceFile, view?: "diff" | "file"): void;
  /** Ctrl+F, F7 / Shift+F7; returns true if consumed. */
  handleKey(e: KeyboardEvent): boolean;
  destroy(): void;
}

// Map a file extension to a Shiki language id. Unknown extensions fall back to
// "text" (Shiki renders it as plain, no highlighting).
export function langFromPath(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    rs: "rust", toml: "toml", json: "json", jsonc: "jsonc",
    md: "markdown", markdown: "markdown", mdx: "mdx",
    html: "html", htm: "html", css: "css", scss: "scss", sass: "sass",
    py: "python", rb: "ruby", go: "go", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", swift: "swift", lua: "lua",
    sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
    yml: "yaml", yaml: "yaml", xml: "xml", svg: "xml", sql: "sql",
    vue: "vue", svelte: "svelte", dart: "dart",
  };
  return map[ext] ?? "text";
}

/** Row indexes where a run of added/removed lines starts: the stops F7 and
 *  Shift+F7 move between. */
export function changeStarts(rows: HTMLElement[]): number[] {
  const out: number[] = [];
  let prevChanged = false;
  rows.forEach((r, i) => {
    const changed = r.classList.contains("fs-add") || r.classList.contains("fs-del")
      || !!r.querySelector(".fs-code.fs-add, .fs-code.fs-del");
    if (changed && !prevChanged) out.push(i);
    prevChanged = changed;
  });
  return out;
}

interface SearchState {
  query: string;
  marks: HTMLElement[];
  cur: number;
}

const SURFACE_HTML =
  `<div class="fs-crumbs">` +
  `<span class="fs-path"></span>` +
  `<span class="fs-grow"></span>` +
  `<div class="fs-search fs-hidden">` +
  `<i class="ph ph-magnifying-glass"></i>` +
  `<input class="fs-search-input" placeholder="Search" aria-label="Search this file" />` +
  `<span class="fs-search-count"></span>` +
  `<button type="button" class="fs-tb fs-search-prev" title="Previous match (Shift+Enter)"><i class="ph ph-caret-up"></i></button>` +
  `<button type="button" class="fs-tb fs-search-next" title="Next match (Enter)"><i class="ph ph-caret-down"></i></button>` +
  `<button type="button" class="fs-tb fs-search-close" title="Close search (Esc)"><i class="ph ph-x"></i></button>` +
  `</div>` +
  `<span class="fs-counts"></span>` +
  `</div>` +
  `<div class="fs-body"></div>`;

const TOOLS_HTML =
  `<div class="fs-diff-tools">` +
  `<button type="button" class="fs-tb fs-split-btn"><i class="ph ph-square-split-horizontal"></i></button>` +
  `<button type="button" class="fs-tb fs-full-btn" title="Full file"><i class="ph ph-arrows-out-line-vertical"></i></button>` +
  `<span class="fs-tsep"></span>` +
  `<button type="button" class="fs-tb fs-prev-chg" title="Previous change (Shift+F7)"><i class="ph ph-caret-up"></i></button>` +
  `<button type="button" class="fs-tb fs-next-chg" title="Next change (F7)"><i class="ph ph-caret-down"></i></button>` +
  `</div>` +
  `<button type="button" class="fs-tb fs-menu-btn" title="More: search, Open in VS Code" aria-haspopup="true"><i class="ph ph-dots-three"></i></button>` +
  `<div class="fs-menu fs-hidden" role="menu">` +
  `<div class="fs-mi" data-act="search" role="menuitem"><i class="ph ph-magnifying-glass"></i><span>Search</span><kbd>Ctrl+F</kbd></div>` +
  `<div class="fs-mi" data-act="view-diff" role="menuitem"><i class="ph ph-git-diff"></i><span>View as diff</span><i class="ph ph-check fs-chk"></i></div>` +
  `<div class="fs-mi" data-act="view-file" role="menuitem"><i class="ph ph-file-text"></i><span>View as file</span><i class="ph ph-check fs-chk"></i></div>` +
  `<div class="fs-sep fs-desktop-only"></div>` +
  `<div class="fs-mi fs-desktop-only" data-act="vscode" role="menuitem"><i class="ph ph-arrow-square-out"></i><span>Open in VS Code</span></div>` +
  `</div>`;

// Layout choices carry across files and openings in this window, like VS Code's
// diff editor; nothing earns persisting them across restarts yet.
let preferredDiffMode: "inline" | "split" = "inline";
let preferredFull = false;

export function createFileSurface(host: HTMLElement, opts: FileSurfaceOptions): FileSurfaceHandle {
  host.innerHTML = SURFACE_HTML;
  host.classList.add("fsurface");
  const tools = document.createElement("div");
  tools.className = "fs-tools";
  tools.innerHTML = TOOLS_HTML;
  (opts.toolsHost ?? host.querySelector<HTMLElement>(".fs-crumbs")!).appendChild(tools);
  // Open in VS Code / reveal act on the desktop's own disk; the phone has none.
  if (isRemote()) tools.querySelectorAll(".fs-desktop-only").forEach((n) => n.remove());

  const el = {
    path: host.querySelector<HTMLElement>(".fs-path")!,
    counts: host.querySelector<HTMLElement>(".fs-counts")!,
    search: host.querySelector<HTMLElement>(".fs-search")!,
    searchInput: host.querySelector<HTMLInputElement>(".fs-search-input")!,
    searchCount: host.querySelector<HTMLElement>(".fs-search-count")!,
    body: host.querySelector<HTMLElement>(".fs-body")!,
    diffTools: tools.querySelector<HTMLElement>(".fs-diff-tools")!,
    splitBtn: tools.querySelector<HTMLButtonElement>(".fs-split-btn")!,
    fullBtn: tools.querySelector<HTMLButtonElement>(".fs-full-btn")!,
    menuBtn: tools.querySelector<HTMLButtonElement>(".fs-menu-btn")!,
    menu: tools.querySelector<HTMLElement>(".fs-menu")!,
  };

  const state = {
    file: null as SurfaceFile | null,
    view: "file" as "diff" | "file",
    diffMode: preferredDiffMode,
    full: preferredFull,
    menuOpen: false,
    loaded: null as TextFileData | null,
    loadedForPath: null as string | null,
    diffRows: null as DiffRow[] | null,
    diffKey: null as string | null,
    diffError: null as string | null,
    diffHighlight: null as DiffHighlightMaps | null,
    diffHighlightKey: null as string | null,
    token: 0,
  };

  let search: SearchState = { query: "", marks: [], cur: -1 };

  function hasDiffSource(file: SurfaceFile): boolean {
    return (!!file.sessionEdits && file.sessionEdits.length > 0) || !!file.gitDiff;
  }

  function resolveView(file: SurfaceFile, requested?: "diff" | "file"): "diff" | "file" {
    const want = requested ?? opts.defaultView;
    if (want === "diff" && !hasDiffSource(file)) return "file";
    return want;
  }

  // ── search ────────────────────────────────────────────────────────────

  function clearSearchMarks(): void {
    for (const m of Array.from(el.body.querySelectorAll<HTMLElement>("mark.fs-hit"))) {
      m.replaceWith(document.createTextNode(m.textContent ?? ""));
    }
    el.body.normalize();
  }

  function updateSearchCount(): void {
    el.searchCount.textContent = search.marks.length ? `${search.cur + 1}/${search.marks.length}` : search.query ? "0" : "";
  }

  function closeSearch(): void {
    clearSearchMarks();
    search = { query: "", marks: [], cur: -1 };
    el.searchInput.value = "";
    updateSearchCount();
    el.search.classList.add("fs-hidden");
  }

  function openSearch(): void {
    el.search.classList.remove("fs-hidden");
    el.searchInput.focus();
    el.searchInput.select();
  }

  function highlightCurrentMatch(): void {
    search.marks.forEach((m, i) => m.classList.toggle("fs-hit-cur", i === search.cur));
    search.marks[search.cur]?.scrollIntoView({ block: "center" });
  }

  function runSearch(query: string): void {
    clearSearchMarks();
    search = { query, marks: [], cur: -1 };
    if (!query) {
      updateSearchCount();
      return;
    }
    const lower = query.toLowerCase();
    const walker = document.createTreeWalker(el.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest("[data-no-search]")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) textNodes.push(n as Text);
    for (const node of textNodes) {
      const value = node.nodeValue ?? "";
      const lowerValue = value.toLowerCase();
      if (!lowerValue.includes(lower)) continue;
      const frag = document.createDocumentFragment();
      let idx = 0;
      let pos = lowerValue.indexOf(lower, idx);
      while (pos !== -1) {
        if (pos > idx) frag.appendChild(document.createTextNode(value.slice(idx, pos)));
        const mark = document.createElement("mark");
        mark.className = "fs-hit";
        mark.textContent = value.slice(pos, pos + query.length);
        frag.appendChild(mark);
        search.marks.push(mark);
        idx = pos + query.length;
        pos = lowerValue.indexOf(lower, idx);
      }
      if (idx < value.length) frag.appendChild(document.createTextNode(value.slice(idx)));
      node.parentNode?.replaceChild(frag, node);
    }
    if (search.marks.length) {
      search.cur = 0;
      highlightCurrentMatch();
    }
    updateSearchCount();
  }

  function jumpSearch(dir: 1 | -1): void {
    if (!search.marks.length) return;
    search.cur = (search.cur + dir + search.marks.length) % search.marks.length;
    highlightCurrentMatch();
    updateSearchCount();
  }

  el.searchInput.addEventListener("input", () => runSearch(el.searchInput.value.trim()));
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    }
  });
  host.querySelector(".fs-search-prev")!.addEventListener("click", () => jumpSearch(-1));
  host.querySelector(".fs-search-next")!.addEventListener("click", () => jumpSearch(1));
  host.querySelector(".fs-search-close")!.addEventListener("click", closeSearch);

  // ── change navigation ─────────────────────────────────────────────────

  function jumpChange(dir: 1 | -1): void {
    const rows = Array.from(el.body.querySelectorAll<HTMLElement>("tr"));
    const starts = changeStarts(rows);
    if (!starts.length) return;
    // A row counts as "here" once its top is within a few px of the viewport
    // top, so a repeated F7 moves on instead of re-landing on the same block.
    const top = el.body.getBoundingClientRect().top + 4;
    const offsets = starts.map((i) => rows[i]!.getBoundingClientRect().top - top);
    const target = dir === 1
      ? starts[offsets.findIndex((o) => o > 1)] ?? starts[0]!
      : starts[findLastIndex(offsets, (o) => o < -1)] ?? starts[starts.length - 1]!;
    rows[target]!.scrollIntoView({ block: "start" });
  }
  tools.querySelector(".fs-prev-chg")!.addEventListener("click", () => jumpChange(-1));
  tools.querySelector(".fs-next-chg")!.addEventListener("click", () => jumpChange(1));

  // ── menu ──────────────────────────────────────────────────────────────

  function setMenuItem(act: string, on: boolean, disabled: boolean): void {
    const item = el.menu.querySelector<HTMLElement>(`[data-act="${act}"]`);
    if (!item) return;
    item.classList.toggle("fs-on", on);
    item.classList.toggle("fs-disabled", disabled);
  }

  function setMenuOpen(open: boolean): void {
    state.menuOpen = open;
    el.menu.classList.toggle("fs-hidden", !open);
    el.menuBtn.classList.toggle("fs-on", open);
  }

  el.menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenuOpen(!state.menuOpen);
  });

  function onDocClick(e: MouseEvent): void {
    if (!state.menuOpen) return;
    const target = e.target as Node;
    if (el.menu.contains(target) || el.menuBtn.contains(target)) return;
    setMenuOpen(false);
  }
  function onDocKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && state.menuOpen) {
      setMenuOpen(false);
      e.stopPropagation();
    }
  }
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown, true);

  el.menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".fs-mi");
    if (!item || item.classList.contains("fs-disabled")) return;
    setMenuOpen(false);
    handleMenuAction(item.dataset.act);
  });

  function setView(view: "diff" | "file"): void {
    if (state.view === view) return;
    state.view = view;
    closeSearch();
    updateBar();
    void renderBody();
  }

  function handleMenuAction(act: string | undefined): void {
    if (!state.file) return;
    switch (act) {
      case "search":
        openSearch();
        break;
      case "view-diff":
        if (hasDiffSource(state.file)) setView("diff");
        break;
      case "view-file":
        setView("file");
        break;
      case "vscode":
        void invoke<void>("open_in_editor", { path: state.file.absPath ?? state.file.path }).catch((err) =>
          console.error("[file-surface] open_in_editor failed", err),
        );
        break;
      default:
        break;
    }
  }

  el.splitBtn.addEventListener("click", () => {
    state.diffMode = preferredDiffMode = state.diffMode === "split" ? "inline" : "split";
    updateBar();
    void renderBody();
  });
  el.fullBtn.addEventListener("click", () => {
    state.full = preferredFull = !state.full;
    updateBar();
    void renderBody();
  });

  // ── bar ───────────────────────────────────────────────────────────────

  function updateBar(): void {
    const file = state.file;
    if (!file) return;
    const isDiff = state.view === "diff";
    const segs = file.path.split("/");
    el.path.innerHTML = segs
      .map((s, i) => `<span class="${i === segs.length - 1 ? "fs-leaf" : ""}">${escapeHtml(s)}</span>`)
      .join(`<i class="ph ph-caret-right"></i>`);
    el.path.title = file.path;
    const parts: string[] = [];
    if (isDiff && (file.added ?? 0) > 0) parts.push(`<span class="diff-add">+${file.added}</span>`);
    if (isDiff && (file.removed ?? 0) > 0) parts.push(`<span class="diff-del">-${file.removed}</span>`);
    el.counts.innerHTML = parts.join("");

    setMenuItem("view-diff", isDiff, !hasDiffSource(file));
    setMenuItem("view-file", !isDiff, false);
    el.diffTools.classList.toggle("fs-hidden", !isDiff);
    const split = state.diffMode === "split";
    el.splitBtn.classList.toggle("fs-on", split);
    el.splitBtn.setAttribute("aria-pressed", String(split));
    el.splitBtn.title = split ? "Side by side (click for inline)" : "Inline (click for side by side)";
    // Whole-file context only exists for git sources; session edits carry
    // just the edited strings.
    el.fullBtn.classList.toggle("fs-hidden", !file.gitDiff);
    el.fullBtn.classList.toggle("fs-on", state.full);
    el.fullBtn.setAttribute("aria-pressed", String(state.full));
  }

  // ── body: file view ──────────────────────────────────────────────────

  function appendTruncationNotice(truncated: boolean): void {
    if (!truncated) return;
    const notice = document.createElement("div");
    notice.className = "fs-truncated";
    notice.innerHTML = `<i class="ph ph-warning"></i> File is large and was truncated. Open in VS Code to see the full contents.`;
    el.body.appendChild(notice);
  }

  async function renderFileBody(token: number): Promise<void> {
    const file = state.file!;
    if (!(state.loaded && state.loadedForPath === file.path)) {
      el.body.innerHTML = `<div class="fs-loading">Loading...</div>`;
      try {
        const data = await file.fileAtRev();
        if (token !== state.token) return;
        state.loaded = data;
        state.loadedForPath = file.path;
      } catch (err) {
        if (token !== state.token) return;
        el.body.innerHTML = `<div class="fs-error">${escapeHtml(String(err))}</div>`;
        return;
      }
    }
    const data = state.loaded!;
    try {
      const { codeToHtml } = await loadShiki();
      const highlighted = await codeToHtml(data.content, { lang: langFromPath(file.path), theme: "github-dark" });
      if (token !== state.token) return;
      el.body.innerHTML = `<div class="fs-code-view">${highlighted}</div>`;
    } catch {
      if (token !== state.token) return;
      const lines = data.content.split("\n").map((l) => `<span class="line">${escapeHtml(l) || "&#8203;"}</span>`);
      el.body.innerHTML = `<div class="fs-code-view"><pre class="fs-plain"><code>${lines.join("\n")}</code></pre></div>`;
    }
    appendTruncationNotice(data.truncated);
  }

  // ── body: diff view ──────────────────────────────────────────────────

  // Rows are keyed by object identity, so this only fires the (lazy,
  // one-call-per-side) shiki pass once per row set and reapplies the cached
  // maps on later mode toggles.
  async function enhanceDiffHighlight(token: number, file: SurfaceFile, rows: DiffRow[]): Promise<void> {
    const key = state.diffKey;
    if (state.diffHighlightKey !== key) {
      state.diffHighlightKey = key; // mark before the await - no duplicate tokenize races
      state.diffHighlight = await highlightDiffRows(rows, langFromPath(file.path));
    }
    if (token !== state.token || state.diffHighlightKey !== key || !state.diffHighlight) return;
    applyDiffHighlight(el.body, rows, state.diffHighlight);
    if (search.query) runSearch(search.query); // re-mark: innerHTML was just replaced
  }

  async function loadDiffRows(token: number, file: SurfaceFile): Promise<boolean> {
    if (file.sessionEdits?.length) {
      const key = `${file.path}|session`;
      if (state.diffKey !== key) {
        state.diffRows = sessionEditsToDiffRows(file.sessionEdits);
        state.diffKey = key;
        state.diffError = null;
      }
      return true;
    }
    if (!file.gitDiff) {
      state.diffRows = null;
      state.diffError = "No diff available for this file.";
      return true;
    }
    const key = `${file.path}|${state.full}`;
    if (state.diffKey === key) return true;
    el.body.innerHTML = `<div class="fs-loading">Loading diff...</div>`;
    try {
      const text = await file.gitDiff({ full: state.full });
      if (token !== state.token) return false;
      state.diffRows = parseUnifiedDiff(text);
      state.diffError = null;
    } catch (err) {
      if (token !== state.token) return false;
      state.diffRows = null;
      state.diffError = String(err);
    }
    state.diffKey = key;
    return true;
  }

  async function renderDiffBody(token: number): Promise<void> {
    const file = state.file!;
    if (!(await loadDiffRows(token, file)) || token !== state.token) return;
    if (state.diffError || !state.diffRows) {
      el.body.innerHTML = `<div class="fs-error">${escapeHtml(state.diffError ?? "No diff available for this file.")}</div>`;
      return;
    }
    if (!state.diffRows.length) {
      el.body.innerHTML = `<div class="fs-loading">No changes in this file.</div>`;
      return;
    }
    el.body.innerHTML = state.diffMode === "split" ? renderSplitDiffHtml(state.diffRows) : renderUnifiedDiffHtml(state.diffRows);
    void enhanceDiffHighlight(token, file, state.diffRows);
  }

  async function renderBody(): Promise<void> {
    const token = state.token;
    if (!state.file) {
      el.body.innerHTML = "";
      return;
    }
    if (state.view === "diff") await renderDiffBody(token);
    else await renderFileBody(token);
    if (token !== state.token) return;
    if (search.query) runSearch(search.query);
  }

  // ── keys ──────────────────────────────────────────────────────────────

  function handleKey(e: KeyboardEvent): boolean {
    if (!state.file) return false;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openSearch();
      return true;
    }
    if (e.key === "F7" && state.view === "diff") {
      e.preventDefault();
      jumpChange(e.shiftKey ? -1 : 1);
      return true;
    }
    return false;
  }

  // ── public API ────────────────────────────────────────────────────────

  function show(file: SurfaceFile, view?: "diff" | "file"): void {
    state.token++;
    // A tab reopened from another scope keeps its path but swaps its source,
    // so cached content is keyed on the file object, not the path.
    const sameFile = state.file === file;
    state.file = file;
    state.view = resolveView(file, view);
    state.diffMode = preferredDiffMode;
    state.full = preferredFull;
    if (!sameFile) {
      state.loaded = null;
      state.loadedForPath = null;
      state.diffRows = null;
      state.diffKey = null;
      state.diffError = null;
      state.diffHighlight = null;
      state.diffHighlightKey = null;
    }
    setMenuOpen(false);
    closeSearch();
    updateBar();
    void renderBody();
  }

  function destroy(): void {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onDocKeydown, true);
    tools.remove();
    host.innerHTML = "";
    host.classList.remove("fsurface");
  }

  return { show, handleKey, destroy };
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}
