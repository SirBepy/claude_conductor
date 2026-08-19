// Docked HTML preview panel (ai_todo 138, frontend chunk).
//
// The daemon owns one global preview timeline: terminal Claude (curl to
// `/hooks/preview`) and the in-app chat AI both push HTML snapshots to it,
// each snapshot tagged with the pushing session's `session_id`. This module
// renders that store — live latest + a history rail — as a dockable panel,
// but only for whichever chat is currently active: `setSessionScope` is
// called on every session switch (see state.ts's `setActiveSession`) and
// re-filters the fetched list client-side. A snapshot pushed with no
// session_id (e.g. an ad-hoc curl outside any chat) simply never matches any
// scope and won't appear — that's an accepted, unrequested-workaround-free
// consequence of scoping being per-chat now, not a bug.
//
// `renderPreview(root, { mode })`'s `mode` lets the pop-out OS window reuse
// this exact renderer via `mountPreviewWindow`, called from main.ts's
// `previewSessionId` boot branch.
//
// Live updates arrive two ways, per `project_daemon_notifier_broadcast_lossy`:
// a `preview` daemon-notifier broadcast (fast, but can be dropped under
// backpressure) AND an explicit `list_previews` refetch on panel open/window
// focus (authoritative, never skipped).

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import type { PreviewMeta, PreviewSnapshot } from "../../types/ipc.generated";
import { wireResizeHandle, MIN_WIDTH, MAX_WIDTH } from "./preview-panel-resize";
import { buildPreviewDocumentHtml } from "./preview-panel-document";
import { togglePvMoreMenu, closePvMoreMenu, type DeviceWidth, type PvMoreMenuDeps } from "./preview-panel-more-menu";
import { togglePvHistory, closePvHistory, type PvHistoryDeps } from "./preview-panel-history";
import { mountPvComposer, type PvComposerDeps, type PvComposerHandle } from "./preview-panel-composer";
import { mountTodosPanel, type TodosPanelHandle } from "./todos-panel";
import "../../shared/chat/caret-popup/popup.css";
import "../../shared/chat/composer.css";

export type PreviewMode = "panel" | "window";

/** The rail hosts two tabs (todo 692). The class is still called PreviewPanel
 *  because it owns the host element, the width, the resize handle and the
 *  close button; the Todos tab's own board lives in `todos-panel.ts`. */
export type RailTab = "preview" | "todos";

export interface PreviewController {
  toggle(): void;
  open(snapshotId?: string): void;
  close(): void;
  isOpen(): boolean;
  /** Scopes the panel to one chat's previews, INCLUDING its open/closed
   *  state (each chat remembers its own independently); call on every
   *  active-session switch (see state.ts). Clears and re-fetches when the
   *  id changes. */
  setSessionScope(sessionId: string | null): void;
  /** Relocates this chat's preview to its own OS window (todo 290, panel mode
   *  only). Docked view stays scoped but hidden until dockBack. */
  popOut(): void;
  /** Pop-out window's own dock-back path (window mode only) - clears the
   *  popped flag and closes the OS window. */
  dockBack(): void;
  destroy(): void;
}

// ── Persistence (dock-open + panel width — the real cross-reopen behavior
// per the spec; device-width and history-rail-open stay in-memory, same as
// the removed auto-refresh toggle used to). Open state is keyed per session
// id (Joe, 2026-08-01: opening the panel in one chat must not show it open
// in another) — same per-session-key shape as composer-persistence.ts's
// draftKey. Width stays a single global key; a dragged panel width isn't a
// per-chat preference. ──────────────────────────────────────────────────
const LS_OPEN_PREFIX = "cc_preview_panel_open:";
const LS_WIDTH_KEY = "cc_preview_panel_width";
const LS_POPPED_PREFIX = "cc_preview_panel_popped:";
/** Which tab this chat was last on. Per-session like the open flag - the rail
 *  reopening on Todos in one chat must not put a sibling chat on Todos too. */
const LS_TAB_PREFIX = "cc_rail_tab:";

function loadTab(sessionId: string): RailTab {
  try {
    return localStorage.getItem(LS_TAB_PREFIX + sessionId) === "todos" ? "todos" : "preview";
  } catch {
    return "preview";
  }
}

function saveTab(sessionId: string, tab: RailTab): void {
  try {
    localStorage.setItem(LS_TAB_PREFIX + sessionId, tab);
  } catch {
    /* quota or storage disabled */
  }
}

function openKey(sessionId: string): string {
  return LS_OPEN_PREFIX + sessionId;
}

function loadOpen(sessionId: string): boolean {
  try {
    return localStorage.getItem(openKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

function saveOpen(sessionId: string, open: boolean): void {
  try {
    localStorage.setItem(openKey(sessionId), open ? "1" : "0");
  } catch {
    /* quota or storage disabled */
  }
}

function poppedKey(sessionId: string): string {
  return LS_POPPED_PREFIX + sessionId;
}

function loadPopped(sessionId: string): boolean {
  try {
    return localStorage.getItem(poppedKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

/** Shared localStorage; the constructor's `storage` listener is what makes
 *  the OTHER window's docked instance react to a flip (separate realms). */
function savePopped(sessionId: string, popped: boolean): void {
  try {
    localStorage.setItem(poppedKey(sessionId), popped ? "1" : "0");
  } catch {
    /* quota or storage disabled */
  }
}

/** Explicit px width from a past manual drag, or null if the dev has never
 *  resized it - in which case the panel takes an even 50/50 flex split with
 *  the chat pane (Joe, 2026-07-20: "I want my view to be split into 2"), not
 *  a narrow fixed-px sidebar. Dragging the handle commits a fixed px width
 *  from then on, same as any split-pane. */
function loadWidth(): number | null {
  try {
    const raw = localStorage.getItem(LS_WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n)) return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    /* ignore */
  }
  return null;
}

function saveWidth(px: number): void {
  try {
    localStorage.setItem(LS_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

class PreviewPanel implements PreviewController {
  private root: HTMLElement;
  private mode: PreviewMode;
  private snapshots: PreviewMeta[] = [];
  private selected: PreviewSnapshot | null = null;
  /** Full-html snapshots already fetched this session, keyed by id, so
   *  revisiting a chat (or a window-focus refetch) never re-invokes
   *  get_preview or rebuilds the iframe for content already seen. Pruned in
   *  refreshList to whatever ids the daemon's list still reports, so it can
   *  never outgrow the daemon-side MAX_HISTORY cap. */
  private snapshotCache = new Map<string, PreviewSnapshot>();
  private deviceWidth: DeviceWidth = "desktop";
  private openState: boolean;
  /** Explicit manually-dragged px width, or null for the default 50/50 flex
   *  split with the chat pane - see loadWidth's doc. */
  private width: number | null;
  /** Only previews pushed with this session_id are shown. Set by
   *  state.ts's setActiveSession on every chat switch; null before any
   *  chat is selected. */
  private currentSessionId: string | null = null;
  /** Ids already shown (or baselined) this window session - see
   *  `checkForUnseen`'s doc for why this exists. In-memory only, same
   *  don't-resurface-what-was-already-surfaced shape as main.ts's
   *  `seenMissedIds`. */
  private seenIds = new Set<string>();
  /** Which of the rail's two tabs is showing. Preview stays the default so an
   *  existing chat opens exactly where it used to. */
  private activeTab: RailTab = "preview";
  private todosPanel: TodosPanelHandle | null = null;
  private unlistenPreview: Unlisten | null = null;
  private focusHandler: (() => void) | null = null;
  private resizeCleanup: (() => void) | null = null;
  /** Panel-mode only: set once popOut() relocates this session's view to its
   *  own OS window; docked host stays scoped but hidden until dockBack(). */
  private popped = false;
  private storageHandler: ((e: StorageEvent) => void) | null = null;
  /** Reply composer docked at the panel's bottom (see preview-panel-composer.ts).
   *  Mounted once in the constructor: unlike the AUQ card, this panel's own
   *  DOM is never innerHTML-rebuilt (renderIframe/renderHeader
   *  only touch their own sub-elements), so there's no per-render remount. */
  private composer: PvComposerHandle | null = null;

  constructor(root: HTMLElement, mode: PreviewMode) {
    this.root = root;
    this.mode = mode;
    this.width = loadWidth();
    // Open state is per-session (see LS_OPEN_PREFIX); unknown until
    // setSessionScope runs, which sessions.ts calls synchronously right
    // after construction - start closed so there's no flash of the wrong
    // chat's open state in between.
    this.openState = false;

    this.applyWidth();
    this.renderShell();
    const todosHost = this.root.querySelector<HTMLElement>('[data-tab-body="todos"]');
    if (todosHost) this.todosPanel = mountTodosPanel(todosHost);
    this.applyTab();
    this.composer = mountPvComposer(this.root, this.pvComposerDeps());
    this.wireEvents();
    this.resizeCleanup = wireResizeHandle(this.root, (px) => {
      this.width = px;
      saveWidth(px);
      this.applyWidth();
    });
    void this.subscribeLive();

    this.focusHandler = () => {
      if (this.openState) void this.refreshList();
      else void this.checkForUnseen();
    };
    window.addEventListener("focus", this.focusHandler);

    if (this.mode === "panel") {
      this.storageHandler = (e: StorageEvent) => {
        if (!this.currentSessionId || e.key !== poppedKey(this.currentSessionId)) return;
        this.popped = e.newValue === "1";
        if (this.popped) this.root.hidden = true;
        else if (this.openState) { this.root.hidden = false; void this.refreshList(); }
      };
      window.addEventListener("storage", this.storageHandler);
    }

    this.root.hidden = true;
    this.renderHeaderEmpty();
    this.renderCanvasEmpty();
  }

  /** Sets the flex sizing on the host element (`this.root`, the actual flex
   *  item inside `.sessions-layout`, sibling to `.session-pane`): an even
   *  50/50 split by default (`flex: 1 1 0%`, matching `.session-pane`'s own
   *  `flex: 1`), or a fixed px width once the dev has dragged the resize
   *  handle (`flex: 0 0 <px>px`). The inner `.preview-panel` div just fills
   *  whatever width this resolves to (width/height 100%). */
  private applyWidth(): void {
    this.root.style.flex = this.width === null ? "1 1 0%" : `0 0 ${this.width}px`;
  }

  // ── Public controller API ────────────────────────────────────────────────

  toggle(): void {
    if (this.openState) this.close();
    else this.open();
  }

  open(snapshotId?: string): void {
    this.openState = true;
    if (this.currentSessionId) saveOpen(this.currentSessionId, true);
    // Relocated to its own window (panel mode only) - stay scoped, stay
    // hidden, until dockBack() clears the flag.
    if (this.mode === "panel" && this.popped) return;
    this.root.hidden = false;
    void this.refreshList(snapshotId ? { selectId: snapshotId } : {});
  }

  close(): void {
    this.openState = false;
    if (this.currentSessionId) saveOpen(this.currentSessionId, false);
    this.root.hidden = true;
  }

  isOpen(): boolean {
    return this.openState;
  }

  setSessionScope(sessionId: string | null): void {
    if (this.currentSessionId === sessionId) return;
    // Chat-switch skips DOM clicks, so the outside-click dismiss never
    // fires for it - close explicitly or the menu stays open across it.
    closePvMoreMenu();
    closePvHistory();
    this.currentSessionId = sessionId;
    // Each chat also remembers which tab it was on; re-derive it here for the
    // same reason as openState, so the previous chat's tab never carries over.
    this.activeTab = sessionId ? loadTab(sessionId) : "preview";
    this.applyTab();
    this.todosPanel?.setSessionScope(sessionId);
    this.popped = this.mode === "panel" && !!sessionId && loadPopped(sessionId);
    // Each chat's open/closed state is independent (loadOpen defaults false
    // for an id with no saved key yet, e.g. one that's never had the panel
    // opened) - re-derive from THIS chat's key, never carry over the
    // previous chat's this.openState.
    if (sessionId && loadOpen(sessionId) && !this.popped) {
      this.openState = true;
      this.root.hidden = false;
      void this.refreshList();
    } else {
      // Popped: still "open" per the saved flag (dockBack needs to know to
      // re-show it), just relocated to its own window - see the class doc.
      this.openState = this.popped && !!sessionId && loadOpen(sessionId);
      this.root.hidden = true;
      // Drop the stale cross-chat cache so a later open() never flashes the
      // previous chat's snapshots before the fresh fetch lands.
      this.snapshots = [];
      this.selected = null;
      this.renderHeaderEmpty();
      this.renderCanvasEmpty();
      // Baseline only - the chat just switched into may already have older
      // previews; those shouldn't force-open the panel, only a push that
      // arrives *after* this baseline should (see checkForUnseen doc).
      void this.checkForUnseen({ allowOpen: false });
    }
  }

  destroy(): void {
    if (this.unlistenPreview) {
      try { this.unlistenPreview(); } catch { /* ignore */ }
      this.unlistenPreview = null;
    }
    if (this.focusHandler) {
      window.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
    if (this.resizeCleanup) { this.resizeCleanup(); this.resizeCleanup = null; }
    if (this.storageHandler) {
      window.removeEventListener("storage", this.storageHandler);
      this.storageHandler = null;
    }
    this.composer?.destroy();
    this.composer = null;
    this.todosPanel?.destroy();
    this.todosPanel = null;
    closePvHistory();
  }

  popOut(): void {
    if (this.mode !== "panel" || !this.currentSessionId) return;
    this.popped = true;
    savePopped(this.currentSessionId, true);
    this.root.hidden = true;
    void invoke("open_preview_window", { sessionId: this.currentSessionId }).catch((err) => {
      console.error("[preview-panel] open_preview_window failed", err);
    });
  }

  dockBack(): void {
    if (this.mode !== "window" || !this.currentSessionId) return;
    savePopped(this.currentSessionId, false);
    void invoke("close_preview_window").catch((err) => {
      console.error("[preview-panel] close_preview_window failed", err);
    });
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  /** Authoritative fallback for the lossy `preview` notifier broadcast (see
   *  class docs): `onLivePush` is the fast path, but a dropped broadcast
   *  packet must never silently swallow a preview Claude just pushed for the
   *  active chat. Called on every window focus while the panel is closed
   *  (and once at mount / on every session-scope change, with `allowOpen:
   *  false`, purely to baseline `seenIds` so pre-existing history never
   *  spuriously pops the panel). Finds any snapshot in the current chat's
   *  scope not yet in `seenIds` and, if allowed, opens the panel on it -
   *  exactly what `onLivePush` does for the fast path. */
  private async checkForUnseen(opts: { allowOpen: boolean } = { allowOpen: true }): Promise<void> {
    if (!this.currentSessionId) return;
    let all: PreviewMeta[];
    try {
      all = await invoke<PreviewMeta[]>("list_previews");
    } catch (err) {
      console.error("[preview-panel] checkForUnseen failed", err);
      return;
    }
    const scoped = (Array.isArray(all) ? all : []).filter((m) => m.session_id === this.currentSessionId);
    const unseen = scoped.filter((m) => !this.seenIds.has(m.id));
    scoped.forEach((m) => this.seenIds.add(m.id));
    const mostRecentUnseen = unseen[unseen.length - 1];
    if (opts.allowOpen && mostRecentUnseen && !this.openState) {
      this.open(mostRecentUnseen.id);
    }
  }

  private async refreshList(opts: { selectId?: string } = {}): Promise<void> {
    try {
      const list = await invoke<PreviewMeta[]>("list_previews");
      const all = Array.isArray(list) ? list : [];
      this.snapshots = all.filter((m) => m.session_id === this.currentSessionId);
      this.snapshots.forEach((s) => this.seenIds.add(s.id));
      const validIds = new Set(all.map((m) => m.id));
      for (const id of this.snapshotCache.keys()) {
        if (!validIds.has(id)) this.snapshotCache.delete(id);
      }
    } catch (err) {
      console.error("[preview-panel] list_previews failed", err);
    }
    const first = this.snapshots[0];
    if (!first) {
      this.selected = null;
      this.renderHeaderEmpty();
      this.renderCanvasEmpty();
      return;
    }
    const targetId = opts.selectId ?? this.selected?.id ?? first.id;
    const stillExists = this.snapshots.some((s) => s.id === targetId);
    await this.selectSnapshot(stillExists ? targetId : first.id);
  }

  private async selectSnapshot(id: string): Promise<void> {
    // Already the exact snapshot on screen (same id + version) — a
    // window-focus refetch or a re-scope back to a chat whose top snapshot
    // hasn't changed. Skip the round-trip and the iframe rebuild entirely so
    // switching chats doesn't re-execute the previewed HTML's scripts.
    const meta = this.snapshots.find((s) => s.id === id);
    if (this.selected?.id === id && (!meta || meta.version === this.selected.version)) {
      return;
    }
    const cached = this.snapshotCache.get(id);
    if (cached && meta && cached.version === meta.version) {
      this.selected = cached;
    } else {
      try {
        this.selected = await invoke<PreviewSnapshot>("get_preview", { id });
      } catch (err) {
        console.error("[preview-panel] get_preview failed", err);
        return;
      }
      this.snapshotCache.set(id, this.selected);
    }
    this.renderHeader();
    void this.renderIframe();
  }

  /** `preview` notifier broadcast handler. Always opens the panel for the
   * active chat's push (Joe, 2026-07-20: no opt-out on auto-refresh). A push
   * for a background chat never switches the view (Joe, 2026-08-03: never
   * force-switch) - it only flags that chat's own open state for next time. */
  private onLivePush(meta: PreviewMeta | undefined): void {
    if (!meta) return;
    if (meta.session_id !== this.currentSessionId) {
      if (meta.session_id) saveOpen(meta.session_id, true);
      return;
    }
    this.seenIds.add(meta.id);

    const idx = this.snapshots.findIndex((s) => s.id === meta.id);
    if (idx >= 0) this.snapshots[idx] = meta;
    else this.snapshots.unshift(meta);

    if (!this.openState) {
      this.open(meta.id);
      return;
    }
    void this.selectSnapshot(meta.id);
  }

  private async subscribeLive(): Promise<void> {
    try {
      this.unlistenPreview = await getTransport().listen<{ snapshot: PreviewMeta }>(
        "preview",
        (payload) => this.onLivePush(payload?.snapshot),
      );
    } catch (err) {
      console.warn("[preview-panel] listen(preview) failed", err);
    }
  }

  private pvComposerDeps(): PvComposerDeps {
    return { getSelected: () => this.selected };
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private openInBrowser(): void {
    if (!this.selected) return;
    // Windows' ShellExecuteW has no protocol handler for data: URLs, so we
    // write a real temp .html file and open that path instead.
    void (async () => {
      try {
        const path = await invoke<string>("write_temp_html", { html: this.selected!.html });
        await invoke("open_external", { url: path });
      } catch (err) {
        console.error("[preview-panel] open_external failed", err);
      }
    })();
  }

  private setDeviceWidth(w: DeviceWidth): void {
    // Segmented buttons live in the shared menu now, not this.root.
    this.deviceWidth = w;
    const frame = this.root.querySelector<HTMLElement>(".pv-frame");
    if (frame) frame.dataset.w = w;
  }

  /** Shows one tab body, hides the other, and syncs the strip's own
   *  contextual buttons: the eye is the Todos Columns menu, the kebab is
   *  Preview's More menu, so neither is ever shown on the other's tab. */
  private applyTab(): void {
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-tab-body]")) {
      el.hidden = el.dataset.tabBody !== this.activeTab;
    }
    for (const el of this.root.querySelectorAll<HTMLElement>(".rail-tab")) {
      el.classList.toggle("on", el.dataset.tab === this.activeTab);
    }
    const columnsBtn = this.root.querySelector<HTMLElement>('[data-act="columns"]');
    if (columnsBtn) columnsBtn.hidden = this.activeTab !== "todos";
  }

  private setTab(tab: RailTab): void {
    if (this.activeTab === tab) return;
    // Both menus belong to the tab being left, and neither dismisses itself on
    // a tab switch (no outside DOM click happens).
    closePvMoreMenu();
    closePvHistory();
    this.activeTab = tab;
    if (this.currentSessionId) saveTab(this.currentSessionId, tab);
    this.applyTab();
    if (tab === "todos") this.todosPanel?.refresh();
  }

  private pvMoreMenuDeps(): PvMoreMenuDeps {
    return {
      onRefresh: () => void this.refreshList(),
      onOpenBrowser: () => this.openInBrowser(),
      onSetDeviceWidth: (w) => this.setDeviceWidth(w),
      getDeviceWidth: () => this.deviceWidth,
    };
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="preview-panel" data-mode="${this.mode}">
        <div class="pv-resize-handle" data-resize title="Drag to resize"></div>
        <div class="rail-strip">
          <button type="button" class="rail-tab" data-tab="preview"><i class="ph ph-monitor-play"></i>Preview</button>
          <button type="button" class="rail-tab" data-tab="todos"><i class="ph ph-list-checks"></i>Todos</button>
          <span class="rail-strip-grow"></span>
          <button type="button" class="pv-icon-btn" data-act="columns" title="Columns" hidden><i class="ph ph-eye"></i></button>
          <button type="button" class="pv-icon-btn" data-act="popout" title="Pop out into its own window"${this.mode === "window" ? " hidden" : ""}><i class="ph ph-arrows-out-simple"></i></button>
          <button type="button" class="pv-icon-btn" data-act="close" title="${this.mode === "window" ? "Dock back into chat" : "Close panel"}"><i class="ph ${this.mode === "window" ? "ph-arrow-line-down" : "ph-x"}"></i></button>
        </div>
        <div class="rail-tab-body" data-tab-body="preview">
          <header class="pv-head">
            <span class="pv-title"><i class="ph ph-monitor-play"></i><span class="pv-name">No previews yet</span></span>
            <button type="button" class="pv-ver" data-act="history" title="Version history"></button>
            <span class="pv-grow"></span>
            <button type="button" class="icon-btn" data-act="more" title="More options"><i class="ph ph-dots-three-vertical"></i></button>
          </header>
          <div class="pv-body">
            <div class="pv-canvas"></div>
          </div>
          <div class="pv-composer">
            <div class="composer-input-wrap">
              <div class="composer-highlight" aria-hidden="true"></div>
              <textarea class="composer-textarea pv-composer-input" rows="1" placeholder="Message the session that pushed this preview..."></textarea>
            </div>
            <button type="button" class="pv-composer-send icon-btn" title="Send" disabled>
              <i class="ph ph-paper-plane-right"></i>
            </button>
          </div>
        </div>
        <div class="rail-tab-body" data-tab-body="todos" hidden></div>
      </div>
    `;
    this.renderCanvasEmpty();
  }

  private renderHeader(): void {
    if (!this.selected) return;
    const nameEl = this.root.querySelector<HTMLElement>(".pv-name");
    const verEl = this.root.querySelector<HTMLElement>(".pv-ver");
    if (nameEl) nameEl.textContent = this.selected.slug;
    if (verEl) {
      verEl.textContent = `· v${this.selected.version}`;
      verEl.hidden = false;
    }
  }

  private renderHeaderEmpty(): void {
    const nameEl = this.root.querySelector<HTMLElement>(".pv-name");
    const verEl = this.root.querySelector<HTMLElement>(".pv-ver");
    if (nameEl) nameEl.textContent = "No previews yet";
    if (verEl) {
      verEl.textContent = "";
      // Nothing to open a history popover on, so the toggle isn't offered.
      verEl.hidden = true;
    }
  }

  private async renderIframe(): Promise<void> {
    if (!this.selected) return;
    const canvas = this.root.querySelector<HTMLElement>(".pv-canvas");
    if (!canvas) return;
    canvas.innerHTML = `<div class="pv-frame" data-w="${this.deviceWidth}"><iframe class="pv-iframe" sandbox="allow-scripts"></iframe></div>`;
    const iframe = canvas.querySelector<HTMLIFrameElement>(".pv-iframe");
    if (!iframe) return;
    // Served over a real local origin (not data:) so it gets its own CSP
    // header, independent of the app shell's - see preview_render.rs. Staged
    // via IPC rather than a webview fetch: that fetch was cross-origin, and its
    // CORS preflight got a 405, so the panel silently rendered blank (todo 591).
    const doc = buildPreviewDocumentHtml(this.selected.html);
    try {
      iframe.src = await invoke<string>("render_preview_doc", { html: doc });
    } catch (err) {
      console.error("[preview-panel] preview-render failed", err);
      canvas.innerHTML = `
        <div class="pv-empty">
          <i class="ph ph-warning-circle"></i>
          <p>Preview failed to render</p>
          <p class="pv-empty-hint">${String(err).replace(/[<>&]/g, "")}</p>
        </div>
      `;
    }
  }

  private renderCanvasEmpty(): void {
    const canvas = this.root.querySelector<HTMLElement>(".pv-canvas");
    if (!canvas) return;
    canvas.innerHTML = `
      <div class="pv-empty">
        <i class="ph ph-monitor-play"></i>
        <p>No previews yet</p>
        <p class="pv-empty-hint">Push one via <code>/preview</code>, or ask the chat AI to show you something.</p>
      </div>
    `;
  }

  private pvHistoryDeps(): PvHistoryDeps {
    return {
      getSnapshots: () => this.snapshots,
      getSelectedId: () => this.selected?.id,
      onSelect: (id) => void this.selectSnapshot(id),
    };
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  private wireEvents(): void {
    this.root.addEventListener("click", (e) => this.onClick(e));
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    const tabBtn = target.closest<HTMLElement>(".rail-tab");
    if (tabBtn?.dataset.tab) {
      this.setTab(tabBtn.dataset.tab as RailTab);
      return;
    }

    const actBtn = target.closest<HTMLElement>("[data-act]");
    if (actBtn) {
      switch (actBtn.dataset.act) {
        case "more": togglePvMoreMenu(actBtn as HTMLButtonElement, this.pvMoreMenuDeps()); return;
        case "history": togglePvHistory(actBtn, this.pvHistoryDeps()); return;
        case "columns": this.todosPanel?.toggleColumnsMenu(actBtn); return;
        case "popout": this.popOut(); return;
        // The strip's single close acts on the whole rail, both tabs (Joe:
        // "the x button closes the entire window").
        case "close": if (this.mode === "window") this.dockBack(); else this.close(); return;
        default: return;
      }
    }
  }
}

/** Shared preview renderer; `mode: "window"` is the todo 290 pop-out,
 *  mounted via `mountPreviewWindow` below. */
export function renderPreview(root: HTMLElement, opts: { mode: PreviewMode }): PreviewController {
  return new PreviewPanel(root, opts.mode);
}

/** Pop-out window bootstrap (todo 290), called from main.ts's boot branch.
 *  Repopulates state.sessions (separate JS module realm) so the reply
 *  composer can resolve the session to send to. */
export async function mountPreviewWindow(root: HTMLElement, sessionId: string): Promise<PreviewController> {
  const { refreshSessions } = await import("./sidebar");
  await refreshSessions();
  const controller = renderPreview(root, { mode: "window" });
  controller.setSessionScope(sessionId);
  controller.open();
  return controller;
}
