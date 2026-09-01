// PR preview modal: rebuilt to the approved design in
// .for_bepy/pr-review-mockup.html (board 1). Sidebar (Commits | Files
// Changed, drill into a commit's files) + center tab strip (permanent
// Description tab + file tabs) sharing ONE embedded file-surface.ts mount
// for diffs. Entry point is handlePrPreviewClick in chat-click-handlers.ts;
// this module owns the modal's construction, state, and git IPC calls.

import { invoke } from "../ipc";
import { escapeHtml } from "../escape-html";
import { basename } from "../path-utils";
import { lockInputToHost } from "../modal";
import { createFileSurface, type FileSurfaceHandle, type SurfaceFile } from "./file-surface";
import {
  resetPrReviewData,
  getCwd,
  getCommits,
  getCommitStat,
  getAllFiles,
  wholeRangeScope,
  commitScope,
  toSurfaceFile,
  loadCommitStats,
  loadAllFiles,
  setPrReviewCwdProvider,
  type Scope,
} from "./pr-review-data";
import type { PrFileChange } from "../../types/ipc.generated";

export { setPrReviewCwdProvider };

interface OpenTab {
  path: string;
  pinned: boolean;
  file: PrFileChange;
  scope: Scope;
}

interface ModalEls {
  sidebarTabsEl: HTMLDivElement;
  commitHeadEl: HTMLDivElement;
  sbBodyEl: HTMLDivElement;
  tabStripEl: HTMLDivElement;
  descPaneEl: HTMLDivElement;
  fileHostEl: HTMLDivElement;
}

let overlay: HTMLDivElement | null = null;
let surface: FileSurfaceHandle | null = null;
let els: ModalEls | null = null;
let unlockInput: (() => void) | null = null;

// j/k step nav and Ctrl+F both route through onModalKeydown regardless of
// where focus sits (see FileSurfaceHandle.handleKey) - let those keep
// reaching it instead of being fully swallowed by the background-input guard.
function isSurfaceNavKey(e: KeyboardEvent): boolean {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") return true;
  return e.key === "j" || e.key === "k";
}

let mSidebarTab: "commits" | "files" = "commits";
let mDrillSha: string | null = null;
let mTabs: OpenTab[] = [];
let mActiveTab: "desc" | string = "desc";

export function closePrModal(): void {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  surface?.destroy();
  surface = null;
  els = null;
  resetPrReviewData(null);
  document.removeEventListener("keydown", onModalKeydown);
  unlockInput?.();
  unlockInput = null;
}

function onModalKeydown(e: KeyboardEvent): void {
  if (mActiveTab !== "desc" && surface) {
    if (surface.handleKey(e)) return;
  }
  if (e.key === "Escape") closePrModal();
}

// ── image inlining + mermaid placeholder passes (Description tab only) ────
// Kept behaving exactly as before the rebuild: a data: URL is the only way a
// local screenshot renders inside the webview (CSP + no file://), so local
// paths are read through the daemon and inlined as base64; remote URLs render
// directly with a placeholder on 404; mermaid code fences get a styled
// "renders on GitHub" placeholder since the modal has no mermaid.js.

const PR_IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
};

function imageMimeFromPath(path: string): string | null {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  return m ? (PR_IMG_MIME[m[1]!] ?? null) : null;
}

function prImgPlaceholder(): HTMLDivElement {
  const ph = document.createElement("div");
  ph.className = "pr-img-placeholder";
  ph.innerHTML = '<i class="ph ph-image"></i><span>Screenshot — drag into GitHub after creating the PR</span>';
  return ph;
}

function applyContentEnhancements(content: HTMLElement): void {
  content.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const isRemote = src.startsWith("https://") || src.startsWith("http://") || src.startsWith("data:");
    if (isRemote) {
      img.addEventListener("error", () => img.replaceWith(prImgPlaceholder()));
      return;
    }
    const localPath = src.replace(/^file:\/\//, "");
    const mime = imageMimeFromPath(localPath);
    if (!mime) { img.replaceWith(prImgPlaceholder()); return; }
    void invoke<string>("read_file_as_base64", { path: localPath })
      .then((b64) => { img.src = `data:${mime};base64,${b64}`; })
      .catch(() => img.replaceWith(prImgPlaceholder()));
  });

  content.querySelectorAll<HTMLElement>("code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    if (!pre) return;
    const source = code.textContent ?? "";
    const wrap = document.createElement("div");
    wrap.className = "pr-mermaid-placeholder";
    wrap.innerHTML = `<div class="pr-mermaid-header"><i class="ph ph-flow-arrow"></i><span>Diagram — renders on GitHub</span></div><pre class="pr-mermaid-source">${escapeHtml(source)}</pre>`;
    pre.replaceWith(wrap);
  });
}

function statusChar(status: string): string {
  return (status || "M").charAt(0).toUpperCase();
}

function statusClass(status: string): string {
  const c = statusChar(status);
  return c === "A" || c === "M" || c === "D" ? `st-${c}` : "st-R";
}

// Git diff paths are always forward-slash, even on Windows, so a plain split
// is safe (basename() from path-utils handles both separators for the name).
function fileDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i + 1) : "";
}

// ── scope resolution ───────────────────────────────────────────────────
// The "current" scope/file-list is whatever the sidebar is drilled into: a
// single commit's range, or the whole-PR range when not drilled. This is
// independent of which sidebar TAB is showing (Commits vs Files Changed) -
// matches the approved mockup's sidebarFiles() helper.

function currentFileScope(): Scope | null {
  if (mDrillSha) return commitScope(mDrillSha);
  return wholeRangeScope();
}

function currentFileList(): PrFileChange[] {
  if (mDrillSha) return getCommitStat(mDrillSha)?.files ?? [];
  return getAllFiles().files ?? [];
}

function navList(): SurfaceFile[] {
  const scope = currentFileScope();
  if (!scope) return [];
  return currentFileList().map((f) => toSurfaceFile(f, scope));
}

// ── tab management ─────────────────────────────────────────────────────

function openFile(f: PrFileChange, scope: Scope, pin: boolean): void {
  const existing = mTabs.find((t) => t.path === f.path);
  if (existing) {
    if (pin) existing.pinned = true;
  } else {
    const preview = mTabs.find((t) => !t.pinned);
    if (pin) {
      mTabs.push({ path: f.path, pinned: true, file: f, scope });
    } else if (preview) {
      preview.path = f.path;
      preview.file = f;
      preview.scope = scope;
    } else {
      mTabs.push({ path: f.path, pinned: false, file: f, scope });
    }
  }
  mActiveTab = f.path;
  renderAll();
}

function closeTab(path: string): void {
  const pos = mTabs.findIndex((t) => t.path === path);
  if (pos < 0) return;
  mTabs.splice(pos, 1);
  if (mActiveTab === path) {
    const next = mTabs[pos] ?? mTabs[pos - 1];
    mActiveTab = next ? next.path : "desc";
  }
  renderAll();
}

// ── rendering ───────────────────────────────────────────────────────────

function renderAll(): void {
  renderSidebar();
  renderTabs();
  renderCenterPane();
}

function renderCenterPane(): void {
  if (!els) return;
  const isDesc = mActiveTab === "desc";
  els.descPaneEl.classList.toggle("pr-hidden", !isDesc);
  els.fileHostEl.classList.toggle("pr-hidden", isDesc);
  if (!isDesc && surface) {
    const tab = mTabs.find((t) => t.path === mActiveTab);
    if (tab) surface.show(toSurfaceFile(tab.file, tab.scope));
  }
}

function renderTabs(): void {
  if (!els) return;
  const strip = els.tabStripEl;
  const descBtn =
    `<button type="button" class="pr-ctab pr-desc-tab ${mActiveTab === "desc" ? "active" : ""}" data-tab="desc">` +
    `<i class="ph ph-article"></i><span class="pr-tab-label">Description</span></button>`;
  const fileBtns = mTabs
    .map((t) => {
      const active = mActiveTab === t.path ? "active" : "";
      const preview = t.pinned ? "" : "preview";
      return (
        `<button type="button" class="pr-ctab ${preview} ${active}" data-tab="${escapeHtml(t.path)}" title="${escapeHtml(t.path)}">` +
        `<span class="pr-file-status ${statusClass(t.file.status)}">${statusChar(t.file.status)}</span>` +
        `<span class="pr-tab-label">${escapeHtml(basename(t.path))}</span>` +
        `<span class="pr-tab-close" data-close="${escapeHtml(t.path)}"><i class="ph ph-x"></i></span></button>`
      );
    })
    .join("");
  strip.innerHTML = descBtn + fileBtns;
  strip.querySelectorAll<HTMLButtonElement>(".pr-ctab").forEach((b) => {
    b.addEventListener("click", (e) => {
      const closer = (e.target as HTMLElement).closest<HTMLElement>("[data-close]");
      if (closer) {
        e.stopPropagation();
        closeTab(closer.dataset.close!);
        return;
      }
      const tab = b.dataset.tab!;
      if (mActiveTab === tab) return;
      mActiveTab = tab;
      renderTabs();
      renderCenterPane();
      renderSidebar();
    });
    b.addEventListener("dblclick", () => {
      const path = b.dataset.tab;
      if (!path || path === "desc") return;
      const t = mTabs.find((x) => x.path === path);
      if (t && !t.pinned) {
        t.pinned = true;
        renderTabs();
      }
    });
  });
  strip.querySelector(".pr-ctab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function updateTabCounts(): void {
  if (!els) return;
  const commitsCount = els.sidebarTabsEl.querySelector<HTMLElement>('[data-sbtab="commits"] .pr-count');
  const filesCount = els.sidebarTabsEl.querySelector<HTMLElement>('[data-sbtab="files"] .pr-count');
  const all = getAllFiles();
  if (commitsCount) commitsCount.textContent = String(getCommits().length);
  if (filesCount) filesCount.textContent = all.files ? String(all.files.length) : all.error ? "?" : "…";
}

function renderSidebar(): void {
  if (!els) return;
  updateTabCounts();

  if (!getCwd()) {
    els.sidebarTabsEl.classList.remove("pr-hidden");
    els.commitHeadEl.classList.add("pr-hidden");
    els.sbBodyEl.innerHTML = `<div class="pr-sb-empty">Files unavailable outside a project session.</div>`;
    return;
  }

  if (mDrillSha) {
    els.sidebarTabsEl.classList.add("pr-hidden");
    els.commitHeadEl.classList.remove("pr-hidden");
    renderCommitHead();
    renderFileRows(getCommitStat(mDrillSha) ?? { files: null, error: null });
    return;
  }

  els.sidebarTabsEl.classList.remove("pr-hidden");
  els.commitHeadEl.classList.add("pr-hidden");
  els.sidebarTabsEl.querySelectorAll<HTMLButtonElement>(".pr-sb-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.sbtab === mSidebarTab);
  });

  if (mSidebarTab === "commits") {
    renderCommitRows();
  } else {
    renderFileRows(getAllFiles());
  }
}

function renderCommitHead(): void {
  if (!els || !mDrillSha) return;
  const c = getCommits().find((x) => x.sha === mDrillSha);
  const stat = getCommitStat(mDrillSha);
  const msgEl = els.commitHeadEl.querySelector<HTMLElement>(".pr-ch-msg")!;
  const shaEl = els.commitHeadEl.querySelector<HTMLElement>(".pr-ch-sha")!;
  const filesEl = els.commitHeadEl.querySelector<HTMLElement>(".pr-ch-files")!;
  const addEl = els.commitHeadEl.querySelector<HTMLElement>(".pr-ch-add")!;
  const delEl = els.commitHeadEl.querySelector<HTMLElement>(".pr-ch-del")!;
  msgEl.textContent = c?.msg ?? "";
  msgEl.title = c?.msg ?? "";
  shaEl.textContent = (c?.sha ?? mDrillSha).slice(0, 7);
  if (!stat || stat.files === null) {
    filesEl.textContent = stat?.error ? "" : "loading…";
    addEl.textContent = "";
    delEl.textContent = "";
  } else if (stat.error) {
    filesEl.textContent = "?";
    addEl.textContent = "";
    delEl.textContent = "";
  } else {
    const add = stat.files.reduce((a, f) => a + f.added, 0);
    const del = stat.files.reduce((a, f) => a + f.removed, 0);
    filesEl.textContent = `${stat.files.length} files`;
    addEl.textContent = `+${add}`;
    delEl.textContent = `-${del}`;
  }
}

function renderCommitRows(): void {
  if (!els) return;
  const commits = getCommits();
  if (commits.length === 0) {
    els.sbBodyEl.innerHTML = `<div class="pr-sb-empty">No commits</div>`;
    return;
  }
  const rows = commits
    .map((c) => {
      const stat = getCommitStat(c.sha);
      let statHtml: string;
      if (!stat || stat.files === null) statHtml = `<span class="pr-sb-muted">…</span>`;
      else if (stat.error) statHtml = `<span class="pr-sb-muted">?</span>`;
      else {
        const add = stat.files.reduce((a, f) => a + f.added, 0);
        const del = stat.files.reduce((a, f) => a + f.removed, 0);
        statHtml = `<span class="files-n">${stat.files.length} files</span><span class="diff-add">+${add}</span><span class="diff-del">-${del}</span>`;
      }
      return (
        `<div class="pr-commit-row" data-sha="${escapeHtml(c.sha)}">` +
        `<div class="top"><span class="sha">${escapeHtml(c.sha.slice(0, 7))}</span><span class="stat">${statHtml}</span></div>` +
        `<div class="msg" title="${escapeHtml(c.msg)}">${escapeHtml(c.msg)}</div></div>`
      );
    })
    .join("");
  els.sbBodyEl.innerHTML = rows + `<div class="pr-sb-hint">click a commit to see its files</div>`;
  els.sbBodyEl.querySelectorAll<HTMLElement>(".pr-commit-row").forEach((r) => {
    r.addEventListener("click", () => {
      mDrillSha = r.dataset.sha ?? null;
      renderSidebar();
    });
  });
}

function renderFileRows(stat: { files: PrFileChange[] | null; error: string | null }): void {
  if (!els) return;
  const scope = currentFileScope();
  if (stat.error) {
    els.sbBodyEl.innerHTML = `<div class="pr-sb-empty">Files unavailable — commit not found in this repo.</div>`;
    return;
  }
  if (stat.files === null) {
    els.sbBodyEl.innerHTML = `<div class="pr-sb-loading">Loading files…</div>`;
    return;
  }
  if (stat.files.length === 0) {
    els.sbBodyEl.innerHTML = `<div class="pr-sb-empty">No files</div>`;
    return;
  }
  const files = stat.files;
  const rows = files
    .map((f) => {
      const active = mActiveTab === f.path ? "active" : "";
      const addHtml = f.added ? `<span class="diff-add">+${f.added}</span>` : "";
      const delHtml = f.removed ? `<span class="diff-del">-${f.removed}</span>` : "";
      return (
        `<div class="pr-file-row ${active}" data-path="${escapeHtml(f.path)}">` +
        `<span class="pr-file-status ${statusClass(f.status)}">${statusChar(f.status)}</span>` +
        `<span class="fname" title="${escapeHtml(f.path)}"><bdo>${escapeHtml(fileDir(f.path))}<b>${escapeHtml(basename(f.path))}</b></bdo></span>` +
        `<span class="fstat">${addHtml}${delHtml}</span></div>`
      );
    })
    .join("");
  els.sbBodyEl.innerHTML = rows + `<div class="pr-sb-hint">single click = preview tab · double click = pinned tab</div>`;
  els.sbBodyEl.querySelectorAll<HTMLElement>(".pr-file-row").forEach((r) => {
    const path = r.dataset.path!;
    const f = files.find((x) => x.path === path);
    if (!f || !scope) return;
    r.addEventListener("click", () => openFile(f, scope, false));
    r.addEventListener("dblclick", () => openFile(f, scope, true));
  });
}

// ── shell construction ─────────────────────────────────────────────────

function buildSidebarShell(): {
  root: HTMLDivElement;
  tabsEl: HTMLDivElement;
  headEl: HTMLDivElement;
  bodyEl: HTMLDivElement;
  tabButtons: HTMLButtonElement[];
  backBtn: HTMLButtonElement;
} {
  const root = document.createElement("div");
  root.className = "pr-sidebar";
  root.innerHTML =
    `<div class="pr-sb-tabs">` +
    `<button type="button" class="pr-sb-tab active" data-sbtab="commits"><i class="ph ph-git-commit"></i>Commits <span class="pr-count">0</span></button>` +
    `<button type="button" class="pr-sb-tab" data-sbtab="files"><i class="ph ph-files"></i>Files Changed <span class="pr-count">0</span></button>` +
    `</div>` +
    `<div class="pr-sb-commit-head pr-hidden">` +
    `<button type="button" class="pr-back" title="Back to all commits"><i class="ph ph-arrow-left"></i></button>` +
    `<div class="pr-ch-info"><div class="pr-ch-msg"></div><div class="pr-ch-meta">` +
    `<span class="sha pr-ch-sha"></span><span class="pr-ch-files"></span><span class="diff-add pr-ch-add"></span><span class="diff-del pr-ch-del"></span>` +
    `</div></div></div>` +
    `<div class="pr-sb-body"></div>`;
  return {
    root,
    tabsEl: root.querySelector<HTMLDivElement>(".pr-sb-tabs")!,
    headEl: root.querySelector<HTMLDivElement>(".pr-sb-commit-head")!,
    bodyEl: root.querySelector<HTMLDivElement>(".pr-sb-body")!,
    tabButtons: Array.from(root.querySelectorAll<HTMLButtonElement>(".pr-sb-tab")),
    backBtn: root.querySelector<HTMLButtonElement>(".pr-back")!,
  };
}

function buildCenterShell(tmpl: HTMLTemplateElement): {
  root: HTMLDivElement;
  tabStripEl: HTMLDivElement;
  closeAllBtn: HTMLButtonElement;
  descPaneEl: HTMLDivElement;
  fileHostEl: HTMLDivElement;
} {
  const root = document.createElement("div");
  root.className = "pr-center";

  const strip = document.createElement("div");
  strip.className = "pr-tabstrip";
  strip.innerHTML =
    `<div class="pr-tabs-scroll"></div>` +
    `<div class="pr-strip-actions"><button type="button" class="pr-hbtn pr-sq pr-close-all" title="Close all file tabs"><i class="ph ph-broom"></i></button></div>`;

  const descPane = document.createElement("div");
  descPane.className = "pr-desc-pane";
  descPane.appendChild(tmpl.content.cloneNode(true));
  applyContentEnhancements(descPane);

  const fileHost = document.createElement("div");
  fileHost.className = "pr-file-host pr-hidden";

  root.appendChild(strip);
  root.appendChild(descPane);
  root.appendChild(fileHost);

  return {
    root,
    tabStripEl: strip.querySelector<HTMLDivElement>(".pr-tabs-scroll")!,
    closeAllBtn: strip.querySelector<HTMLButtonElement>(".pr-close-all")!,
    descPaneEl: descPane,
    fileHostEl: fileHost,
  };
}

// ── entry point ─────────────────────────────────────────────────────────

export function openPrPreviewModal(card: HTMLElement): void {
  const tmpl = card.querySelector<HTMLTemplateElement>("template.pr-modal-tpl");
  if (!tmpl) return;

  closePrModal();
  resetPrReviewData(card);
  mSidebarTab = "commits";
  mDrillSha = null;
  mTabs = [];
  mActiveTab = "desc";

  const ov = document.createElement("div");
  ov.className = "pr-modal-overlay";
  ov.addEventListener("click", (ev) => { if (ev.target === ov) closePrModal(); });
  overlay = ov;

  const modal = document.createElement("div");
  modal.className = "pr-modal";

  const title = card.dataset.prTitle ?? "PR Preview";
  const header = document.createElement("div");
  header.className = "pr-modal-header";
  header.innerHTML = `<i class="ph ph-git-pull-request"></i><span class="pr-modal-title">${escapeHtml(title)}</span><button class="icon-btn-sq pr-modal-close" aria-label="Close"><i class="ph ph-x"></i></button>`;
  header.querySelector<HTMLButtonElement>(".pr-modal-close")!.addEventListener("click", closePrModal);

  const main = document.createElement("div");
  main.className = "pr-modal-content";

  const sidebar = buildSidebarShell();
  const center = buildCenterShell(tmpl);
  main.appendChild(sidebar.root);
  main.appendChild(center.root);

  modal.appendChild(header);
  modal.appendChild(main);
  ov.appendChild(modal);
  document.body.appendChild(ov);
  document.addEventListener("keydown", onModalKeydown);
  unlockInput = lockInputToHost(ov, isSurfaceNavKey);

  els = {
    sidebarTabsEl: sidebar.tabsEl,
    commitHeadEl: sidebar.headEl,
    sbBodyEl: sidebar.bodyEl,
    tabStripEl: center.tabStripEl,
    descPaneEl: center.descPaneEl,
    fileHostEl: center.fileHostEl,
  };

  center.closeAllBtn.addEventListener("click", () => {
    mTabs = [];
    mActiveTab = "desc";
    renderAll();
  });
  sidebar.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      mSidebarTab = (btn.dataset.sbtab as "commits" | "files") ?? "commits";
      renderSidebar();
    });
  });
  sidebar.backBtn.addEventListener("click", () => {
    mDrillSha = null;
    renderSidebar();
  });

  surface = createFileSurface(center.fileHostEl, {
    defaultView: "diff",
    nav: {
      list: navList,
      onStep: (index) => {
        const scope = currentFileScope();
        const f = currentFileList()[index];
        if (scope && f) openFile(f, scope, false);
      },
    },
  });

  renderAll();

  if (getCwd()) {
    void loadCommitStats(renderSidebar);
    void loadAllFiles(renderSidebar);
  }
}
