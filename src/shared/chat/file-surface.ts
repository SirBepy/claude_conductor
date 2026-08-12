// Shared "file surface" - the bar (view label + counts, search, nav stepper,
// ⋮ menu) plus body (File / Diff view) used by both the standalone file
// viewer (file-viewer.ts) and, in future, an embedded PR-review file tab. One
// factory mounted per host element; same DOM, same CSS (file-surface.css),
// same behavior everywhere it's mounted. See .for_bepy/pr-review-mockup.html
// for the approved UX this mirrors.

import { invoke } from "../ipc";
import { basename } from "../path-utils";
import { escapeHtml } from "../escape-html";
// REUSE the existing full Shiki build (same highlighter the chat diffs use),
// loaded lazily via shiki-loader (see its header comment) so it's not in the
// main bundle at boot. The /web bundle lacks rust/toml/etc grammars, so the
// lazy import MUST stay /bundle/full.
import { loadShiki } from "./shiki-loader";
import { renderStackedDiff } from "./edit-window";
import { enhanceEditDiffs } from "./diff-enhancer";
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
  path: string;
  added?: number;
  removed?: number;
  // Diff sources - at most one is set:
  sessionEdits?: FileEditView[]; // this session's edits -> renderStackedDiff (inline only)
  gitDiff?: () => Promise<string>; // raw unified git diff text (parsed + rendered by the surface)
}

export interface FileSurfaceOptions {
  defaultView: "diff" | "file";
  nav?: { list: () => SurfaceFile[]; onStep: (index: number) => void } | null;
  onFileShown?: (f: SurfaceFile) => void;
}

export interface FileSurfaceHandle {
  show(file: SurfaceFile, view?: "diff" | "file"): void;
  step(dir: 1 | -1): void;
  handleKey(e: KeyboardEvent): boolean; // j/k + Ctrl+F handling; returns true if consumed
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

interface SearchState {
  query: string;
  marks: HTMLElement[];
  cur: number;
}

const BAR_HTML =
  `<div class="fs-bar">` +
  `<div class="fs-mode"><i class="ph"></i><span class="fs-mode-label"></span><span class="fs-counts"></span></div>` +
  `<div class="fs-right">` +
  `<div class="fs-search">` +
  `<i class="ph ph-magnifying-glass"></i>` +
  `<input type="text" class="fs-search-input" placeholder="Search" />` +
  `<span class="fs-search-count"></span>` +
  `<button type="button" class="fs-btn fs-sq fs-search-prev" title="Previous match"><i class="ph ph-caret-up"></i></button>` +
  `<button type="button" class="fs-btn fs-sq fs-search-next" title="Next match"><i class="ph ph-caret-down"></i></button>` +
  `</div>` +
  `<span class="fs-navpos"></span>` +
  `<button type="button" class="fs-btn fs-sq fs-prev" title="Previous file (k)"><i class="ph ph-caret-up"></i></button>` +
  `<button type="button" class="fs-btn fs-sq fs-next" title="Next file (j)"><i class="ph ph-caret-down"></i></button>` +
  `<button type="button" class="fs-btn fs-sq fs-menu-btn" title="View options" aria-haspopup="true"><i class="ph ph-dots-three-vertical"></i></button>` +
  `</div>` +
  `<div class="fs-edit-actions fs-hidden">` +
  `<button type="button" class="fs-btn fs-save"><i class="ph ph-floppy-disk"></i><span>Save</span></button>` +
  `<button type="button" class="fs-btn fs-cancel"><i class="ph ph-x-circle"></i><span>Cancel</span></button>` +
  `</div>` +
  `<div class="fs-menu fs-hidden">` +
  `<div class="fs-mi" data-act="view-diff"><i class="ph ph-git-diff"></i><span>View as diff</span><i class="ph ph-check fs-chk"></i></div>` +
  `<div class="fs-mi" data-act="view-file"><i class="ph ph-file-text"></i><span>View as file</span><i class="ph ph-check fs-chk"></i></div>` +
  `<div class="fs-sep"></div>` +
  `<div class="fs-mi" data-act="mode-inline"><i class="ph ph-rows"></i><span>Inline diff</span><i class="ph ph-check fs-chk"></i></div>` +
  `<div class="fs-mi" data-act="mode-split"><i class="ph ph-columns"></i><span>Side by side</span><i class="ph ph-check fs-chk"></i></div>` +
  `<div class="fs-sep"></div>` +
  `<div class="fs-mi" data-act="edit"><i class="ph ph-pencil-simple"></i><span>Edit file</span></div>` +
  `<div class="fs-mi" data-act="vscode"><i class="ph ph-arrow-square-out"></i><span>Open in VS Code</span></div>` +
  `</div>` +
  `</div>` +
  `<div class="fs-body"></div>`;

export function createFileSurface(host: HTMLElement, opts: FileSurfaceOptions): FileSurfaceHandle {
  host.innerHTML = BAR_HTML;
  host.classList.add("fsurface");

  const el = {
    modeIcon: host.querySelector<HTMLElement>(".fs-mode > .ph")!,
    modeLabel: host.querySelector<HTMLElement>(".fs-mode-label")!,
    counts: host.querySelector<HTMLElement>(".fs-counts")!,
    right: host.querySelector<HTMLElement>(".fs-right")!,
    editActions: host.querySelector<HTMLElement>(".fs-edit-actions")!,
    saveBtn: host.querySelector<HTMLButtonElement>(".fs-save")!,
    cancelBtn: host.querySelector<HTMLButtonElement>(".fs-cancel")!,
    searchInput: host.querySelector<HTMLInputElement>(".fs-search-input")!,
    searchCount: host.querySelector<HTMLElement>(".fs-search-count")!,
    searchPrev: host.querySelector<HTMLButtonElement>(".fs-search-prev")!,
    searchNext: host.querySelector<HTMLButtonElement>(".fs-search-next")!,
    navpos: host.querySelector<HTMLElement>(".fs-navpos")!,
    prevBtn: host.querySelector<HTMLButtonElement>(".fs-prev")!,
    nextBtn: host.querySelector<HTMLButtonElement>(".fs-next")!,
    menuBtn: host.querySelector<HTMLButtonElement>(".fs-menu-btn")!,
    menu: host.querySelector<HTMLElement>(".fs-menu")!,
    body: host.querySelector<HTMLElement>(".fs-body")!,
  };

  const state = {
    file: null as SurfaceFile | null,
    view: "file" as "diff" | "file",
    diffMode: "inline" as "inline" | "split",
    editing: false,
    wantEdit: false,
    saving: false,
    menuOpen: false,
    loaded: null as TextFileData | null,
    loadedForPath: null as string | null,
    gitDiffRows: null as DiffRow[] | null,
    gitDiffForPath: null as string | null,
    gitDiffError: null as string | null,
    sessionDiffRows: null as DiffRow[] | null,
    sessionDiffRowsForPath: null as string | null,
    diffHighlight: null as DiffHighlightMaps | null,
    diffHighlightForPath: null as string | null,
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
    const marks = Array.from(el.body.querySelectorAll<HTMLElement>("mark.fs-hit"));
    for (const m of marks) {
      m.replaceWith(document.createTextNode(m.textContent ?? ""));
    }
    el.body.normalize();
  }

  function updateSearchCount(): void {
    el.searchCount.textContent = search.marks.length ? `${search.cur + 1}/${search.marks.length}` : "";
  }

  function clearSearch(): void {
    clearSearchMarks();
    search = { query: "", marks: [], cur: -1 };
    el.searchInput.value = "";
    updateSearchCount();
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
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-no-search]")) return NodeFilter.FILTER_REJECT;
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
    }
  });
  el.searchPrev.addEventListener("click", () => jumpSearch(-1));
  el.searchNext.addEventListener("click", () => jumpSearch(1));

  // ── menu ──────────────────────────────────────────────────────────────

  function setMenuItem(act: string, on: boolean, disabled: boolean): void {
    const item = el.menu.querySelector<HTMLElement>(`[data-act="${act}"]`);
    if (!item) return;
    item.classList.toggle("fs-on", on);
    item.classList.toggle("fs-disabled", disabled);
  }

  function toggleMenu(): void {
    state.menuOpen = !state.menuOpen;
    el.menu.classList.toggle("fs-hidden", !state.menuOpen);
  }

  function closeMenu(): void {
    if (!state.menuOpen) return;
    state.menuOpen = false;
    el.menu.classList.add("fs-hidden");
  }

  el.menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  function onDocClick(e: MouseEvent): void {
    if (!state.menuOpen) return;
    const target = e.target as Node;
    if (el.menu.contains(target) || el.menuBtn.contains(target)) return;
    closeMenu();
  }
  function onDocKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && state.menuOpen) {
      closeMenu();
      e.stopPropagation();
    }
  }
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown);

  el.menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".fs-mi");
    if (!item || item.classList.contains("fs-disabled")) return;
    const act = item.dataset.act;
    closeMenu();
    handleMenuAction(act);
  });

  function onViewChanged(): void {
    clearSearch();
    updateBar();
    void renderBody();
  }

  function handleMenuAction(act: string | undefined): void {
    if (!state.file) return;
    switch (act) {
      case "view-diff":
        if (state.view !== "diff" && hasDiffSource(state.file)) {
          state.view = "diff";
          state.editing = false;
          onViewChanged();
        }
        break;
      case "view-file":
        if (state.view !== "file") {
          state.view = "file";
          state.editing = false;
          onViewChanged();
        }
        break;
      case "mode-inline":
        if (state.view === "diff" && state.diffMode !== "inline") {
          state.diffMode = "inline";
          updateBar();
          void renderBody();
        }
        break;
      case "mode-split":
        if (state.view === "diff" && state.diffMode !== "split") {
          state.diffMode = "split";
          updateBar();
          void renderBody();
        }
        break;
      case "edit":
        // Disallow entering edit mode for an already-loaded truncated file.
        if (state.loadedForPath === state.file.path && state.loaded?.truncated) break;
        state.wantEdit = true;
        if (state.view !== "file") {
          state.view = "file";
          onViewChanged();
        } else {
          void renderBody();
        }
        break;
      case "vscode":
        void invoke<void>("open_in_editor", { path: state.file.path }).catch((err) =>
          console.error("[file-surface] open_in_editor failed", err),
        );
        break;
      default:
        break;
    }
  }

  el.cancelBtn.addEventListener("click", () => {
    state.editing = false;
    state.wantEdit = false;
    updateBar();
    void renderBody();
  });
  el.saveBtn.addEventListener("click", () => void saveEdits());

  // ── bar ───────────────────────────────────────────────────────────────

  function updateBar(): void {
    const file = state.file;
    if (!file) return;
    const isDiff = state.view === "diff";
    el.modeIcon.className = `ph ${isDiff ? "ph-git-diff" : "ph-file-text"}`;
    el.modeLabel.textContent = isDiff ? "Diff" : "File";
    if (isDiff) {
      const added = file.added ?? 0;
      const removed = file.removed ?? 0;
      const parts: string[] = [];
      if (added > 0) parts.push(`<span class="diff-add">+${added}</span>`);
      if (removed > 0) parts.push(`<span class="diff-del">-${removed}</span>`);
      el.counts.innerHTML = parts.join(" ");
    } else {
      el.counts.innerHTML = "";
    }

    const hasDiff = hasDiffSource(file);
    setMenuItem("view-diff", isDiff, !hasDiff);
    setMenuItem("view-file", !isDiff, false);
    setMenuItem("mode-inline", state.diffMode === "inline", !isDiff);
    setMenuItem("mode-split", state.diffMode === "split", !isDiff);

    if (opts.nav) {
      const list = opts.nav.list();
      const pos = list.findIndex((f) => f.path === file.path);
      el.navpos.textContent = pos >= 0 ? `${pos + 1} / ${list.length}` : `- / ${list.length}`;
      el.navpos.classList.remove("fs-hidden");
      el.prevBtn.classList.remove("fs-hidden");
      el.nextBtn.classList.remove("fs-hidden");
    } else {
      el.navpos.classList.add("fs-hidden");
      el.prevBtn.classList.add("fs-hidden");
      el.nextBtn.classList.add("fs-hidden");
    }

    el.right.classList.toggle("fs-hidden", state.editing);
    el.editActions.classList.toggle("fs-hidden", !state.editing);
    el.saveBtn.disabled = state.saving;
  }

  // ── body: file view ──────────────────────────────────────────────────

  function appendTruncationNotice(truncated: boolean): void {
    if (!truncated) return;
    const notice = document.createElement("div");
    notice.className = "fs-truncated";
    notice.innerHTML =
      `<i class="ph ph-warning"></i> File is large and was truncated. ` +
      `Open in VS Code to see (and edit) the full contents.`;
    el.body.appendChild(notice);
  }

  async function renderFileView(data: TextFileData): Promise<void> {
    const lang = langFromPath(state.file!.path);
    try {
      const { codeToHtml } = await loadShiki();
      const highlighted = await codeToHtml(data.content, { lang, theme: "github-dark" });
      el.body.innerHTML = `<div class="fs-code-view">${highlighted}</div>`;
    } catch {
      const lines = data.content.split("\n").map((l) => `<span class="line">${escapeHtml(l) || "&#8203;"}</span>`);
      el.body.innerHTML = `<div class="fs-code-view"><pre class="fs-plain"><code>${lines.join("\n")}</code></pre></div>`;
    }
    appendTruncationNotice(data.truncated);
  }

  function renderEditor(content: string): void {
    el.body.innerHTML = `<textarea class="fs-editor" spellcheck="false"></textarea>`;
    const ta = el.body.querySelector<HTMLTextAreaElement>(".fs-editor");
    if (ta) {
      ta.value = content;
      ta.focus();
    }
  }

  function showEditError(msg: string): void {
    el.body.querySelector(".fs-error-inline")?.remove();
    const div = document.createElement("div");
    div.className = "fs-error fs-error-inline";
    div.textContent = `Save failed: ${msg}`;
    el.body.prepend(div);
  }

  async function saveEdits(): Promise<void> {
    if (!state.file || !state.loaded) return;
    const ta = el.body.querySelector<HTMLTextAreaElement>(".fs-editor");
    if (!ta) return;
    const content = ta.value;
    state.saving = true;
    updateBar();
    try {
      await invoke<void>("write_text_file", { path: state.file.path, content });
    } catch (err) {
      state.saving = false;
      updateBar();
      showEditError(String(err));
      return;
    }
    state.loaded = { content, truncated: state.loaded.truncated };
    state.editing = false;
    state.saving = false;
    updateBar();
    await renderBody();
  }

  async function ensureLoaded(token: number): Promise<boolean> {
    const file = state.file!;
    if (state.loaded && state.loadedForPath === file.path) return true;
    el.body.innerHTML = `<div class="fs-loading">Loading...</div>`;
    try {
      state.loaded = await invoke<TextFileData>("read_text_file", { path: file.path });
      state.loadedForPath = file.path;
    } catch (err) {
      if (token !== state.token) return false;
      el.body.innerHTML = `<div class="fs-error">${escapeHtml(String(err))}</div>`;
      return false;
    }
    return token === state.token;
  }

  async function renderFileBody(token: number): Promise<void> {
    if (!(await ensureLoaded(token))) return;
    if (token !== state.token || !state.loaded) return;

    if (state.editing) {
      renderEditor(state.loaded.content);
      return;
    }

    await renderFileView(state.loaded);
    if (token !== state.token) return;

    if (state.wantEdit) {
      state.wantEdit = false;
      if (!state.loaded.truncated) {
        state.editing = true;
        renderEditor(state.loaded.content);
        updateBar();
      }
    }
  }

  // ── body: diff view ──────────────────────────────────────────────────

  // Shared highlight cache for both diff sources: rows are keyed by object
  // identity, so this only fires the (lazy, one-call-per-side) shiki pass
  // once per path and reapplies the cached maps on later mode toggles.
  async function enhanceDiffHighlight(token: number, file: SurfaceFile, rows: DiffRow[]): Promise<void> {
    if (state.diffHighlightForPath !== file.path) {
      state.diffHighlightForPath = file.path; // mark before the await - no duplicate tokenize races
      state.diffHighlight = await highlightDiffRows(rows, langFromPath(file.path));
    }
    if (token !== state.token || state.diffHighlightForPath !== file.path || !state.diffHighlight) return;
    applyDiffHighlight(el.body, rows, state.diffHighlight);
    if (search.query) runSearch(search.query); // re-mark: innerHTML was just replaced
  }

  async function renderDiffBody(token: number): Promise<void> {
    const file = state.file!;
    if (file.sessionEdits && file.sessionEdits.length) {
      if (state.diffMode === "split") {
        if (state.sessionDiffRowsForPath !== file.path) {
          state.sessionDiffRows = sessionEditsToDiffRows(file.sessionEdits);
          state.sessionDiffRowsForPath = file.path;
        }
        const rows = state.sessionDiffRows!;
        el.body.innerHTML = renderSplitDiffHtml(rows);
        void enhanceDiffHighlight(token, file, rows);
        return;
      }
      el.body.innerHTML = `<div class="fs-session-diff">${renderStackedDiff(file.sessionEdits)}</div>`;
      const diffEl = el.body.querySelector<HTMLElement>(".fs-session-diff");
      if (diffEl) await enhanceEditDiffs(diffEl);
      return;
    }

    if (file.gitDiff) {
      if (state.gitDiffForPath !== file.path) {
        el.body.innerHTML = `<div class="fs-loading">Loading diff...</div>`;
        try {
          const text = await file.gitDiff();
          if (token !== state.token) return;
          state.gitDiffRows = parseUnifiedDiff(text);
          state.gitDiffForPath = file.path;
          state.gitDiffError = null;
        } catch (err) {
          if (token !== state.token) return;
          state.gitDiffRows = null;
          state.gitDiffForPath = file.path;
          state.gitDiffError = String(err);
        }
      }
      if (token !== state.token) return;
      if (state.gitDiffError) {
        el.body.innerHTML = `<div class="fs-error">${escapeHtml(state.gitDiffError)}</div>`;
        return;
      }
      if (state.gitDiffRows) {
        el.body.innerHTML =
          state.diffMode === "split"
            ? renderSplitDiffHtml(state.gitDiffRows)
            : renderUnifiedDiffHtml(state.gitDiffRows);
        void enhanceDiffHighlight(token, file, state.gitDiffRows);
      }
      return;
    }

    el.body.innerHTML = `<div class="fs-error">No diff available for this file.</div>`;
  }

  async function renderBody(): Promise<void> {
    const token = state.token;
    if (!state.file) {
      el.body.innerHTML = "";
      return;
    }
    if (state.view === "diff") {
      await renderDiffBody(token);
    } else {
      await renderFileBody(token);
    }
    if (token !== state.token) return;
    if (search.query) runSearch(search.query);
  }

  // ── nav / keys ────────────────────────────────────────────────────────

  function step(dir: 1 | -1): void {
    if (!opts.nav || !state.file) return;
    const list = opts.nav.list();
    if (!list.length) return;
    const pos = list.findIndex((f) => f.path === state.file!.path);
    const base = pos >= 0 ? pos : 0;
    const next = Math.min(Math.max(base + dir, 0), list.length - 1);
    if (next === pos) return;
    opts.nav.onStep(next);
  }
  el.prevBtn.addEventListener("click", () => step(-1));
  el.nextBtn.addEventListener("click", () => step(1));

  function handleKey(e: KeyboardEvent): boolean {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
      return true;
    }
    const target = e.target;
    const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (inField || state.editing) return false;
    if (e.key === "j") {
      step(1);
      return true;
    }
    if (e.key === "k") {
      step(-1);
      return true;
    }
    return false;
  }

  // ── public API ────────────────────────────────────────────────────────

  function show(file: SurfaceFile, view?: "diff" | "file"): void {
    state.token++;
    state.file = file;
    state.view = resolveView(file, view);
    state.diffMode = "inline";
    state.editing = false;
    state.wantEdit = false;
    state.saving = false;
    if (state.loadedForPath !== file.path) {
      state.loaded = null;
      state.loadedForPath = null;
    }
    if (state.gitDiffForPath !== file.path) {
      state.gitDiffRows = null;
      state.gitDiffForPath = null;
      state.gitDiffError = null;
    }
    if (state.sessionDiffRowsForPath !== file.path) {
      state.sessionDiffRows = null;
      state.sessionDiffRowsForPath = null;
    }
    if (state.diffHighlightForPath !== file.path) {
      state.diffHighlight = null;
      state.diffHighlightForPath = null;
    }
    closeMenu();
    clearSearch();
    opts.onFileShown?.(file);
    updateBar();
    void renderBody();
  }

  function destroy(): void {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onDocKeydown);
    host.innerHTML = "";
    host.classList.remove("fsurface");
  }

  return { show, step, handleKey, destroy };
}
