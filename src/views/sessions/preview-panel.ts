// The rail's Preview tab body (ai_todo 138; rail shell split out to
// rail-panel.ts by todo 702). Renders the daemon's one global preview
// timeline, filtered to the active chat, so a snapshot pushed with no
// session_id matches no scope and never appears (accepted, not a bug).
//
// Live updates arrive two ways, per `project_daemon_notifier_broadcast_lossy`:
// a `preview` broadcast (fast, droppable under backpressure) AND an explicit
// `list_previews` refetch on open/focus (authoritative, never skipped).

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import type { PreviewMeta, PreviewSnapshot } from "../../types/ipc.generated";
import { buildPreviewDocumentHtml } from "./preview-panel-document";
import { togglePvMoreMenu, closePvMoreMenu, type DeviceWidth, type PvMoreMenuDeps } from "./preview-panel-more-menu";
import { togglePvHistory, closePvHistory, type PvHistoryDeps } from "./preview-panel-history";
import { mountPvComposer, type PvComposerDeps, type PvComposerHandle } from "./preview-panel-composer";
import { mountRail, type RailController, type RailMode, type RailTabDeps, type RailTabHandle } from "./rail-panel";
import "../../shared/chat/caret-popup/popup.css";
import "../../shared/chat/composer.css";

export type { RailTab, RailMode as PreviewMode } from "./rail-panel";
/** The rail is what callers hold onto; the name predates the tab split. */
export type PreviewController = RailController;

class PreviewTab implements RailTabHandle {
  private root: HTMLElement;
  private deps: RailTabDeps;
  private snapshots: PreviewMeta[] = [];
  private selected: PreviewSnapshot | null = null;
  /** Full-html snapshots already fetched this session, keyed by id, so
   *  revisiting a chat (or a window-focus refetch) never re-invokes
   *  get_preview or rebuilds the iframe for content already seen. Pruned in
   *  refreshList to whatever ids the daemon's list still reports, so it can
   *  never outgrow the daemon-side MAX_HISTORY cap. */
  private snapshotCache = new Map<string, PreviewSnapshot>();
  private deviceWidth: DeviceWidth = "desktop";
  /** Only previews pushed with this session_id are shown. Set by
   *  state.ts's setActiveSession on every chat switch; null before any
   *  chat is selected. */
  private currentSessionId: string | null = null;
  /** Ids already shown (or baselined) this window session - see
   *  `checkForUnseen`'s doc for why this exists. In-memory only, same
   *  don't-resurface-what-was-already-surfaced shape as main.ts's
   *  `seenMissedIds`. */
  private seenIds = new Set<string>();
  private unlistenPreview: Unlisten | null = null;
  private focusHandler: (() => void) | null = null;
  /** Reply composer docked at the tab's bottom (see preview-panel-composer.ts).
   *  Mounted once in the constructor: unlike the AUQ card, this tab's own
   *  DOM is never innerHTML-rebuilt (renderIframe/renderHeader
   *  only touch their own sub-elements), so there's no per-render remount. */
  private composer: PvComposerHandle | null = null;

  constructor(root: HTMLElement, deps: RailTabDeps) {
    this.root = root;
    this.deps = deps;

    this.renderShell();
    this.composer = mountPvComposer(this.root, this.pvComposerDeps());
    this.root.addEventListener("click", (e) => this.onClick(e));
    void this.subscribeLive();

    this.focusHandler = () => {
      if (this.deps.isOpen()) void this.refreshList();
      else void this.checkForUnseen();
    };
    window.addEventListener("focus", this.focusHandler);

    this.renderHeaderEmpty();
    this.renderCanvasEmpty();
  }

  // ── Rail tab handle ──────────────────────────────────────────────────────

  setSessionScope(sessionId: string | null): void {
    if (this.currentSessionId === sessionId) return;
    this.closeMenus();
    this.currentSessionId = sessionId;
    if (this.deps.isVisible()) {
      void this.refreshList();
      return;
    }
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

  refresh(opts: { selectId?: string } = {}): void {
    void this.refreshList(opts);
  }

  closeMenus(): void {
    closePvMoreMenu();
    closePvHistory();
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
    this.composer?.destroy();
    this.composer = null;
    closePvHistory();
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  /** Authoritative fallback for the lossy `preview` broadcast (see module
   *  docs): a dropped packet must never swallow a push for the active chat.
   *  Runs on window focus while closed, and with `allowOpen: false` on every
   *  scope change purely to baseline `seenIds` against pre-existing history. */
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
    if (opts.allowOpen && mostRecentUnseen && !this.deps.isOpen()) {
      this.deps.requestOpen(mostRecentUnseen.id);
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
      if (meta.session_id) this.deps.markOpenFor(meta.session_id);
      return;
    }
    this.seenIds.add(meta.id);

    const idx = this.snapshots.findIndex((s) => s.id === meta.id);
    if (idx >= 0) this.snapshots[idx] = meta;
    else this.snapshots.unshift(meta);

    if (!this.deps.isOpen()) {
      this.deps.requestOpen(meta.id);
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

  private pvComposerDeps(): PvComposerDeps {
    return { getSelected: () => this.selected };
  }

  private pvMoreMenuDeps(): PvMoreMenuDeps {
    return {
      onRefresh: () => void this.refreshList(),
      onOpenBrowser: () => this.openInBrowser(),
      onSetDeviceWidth: (w) => this.setDeviceWidth(w),
      getDeviceWidth: () => this.deviceWidth,
    };
  }

  private pvHistoryDeps(): PvHistoryDeps {
    return {
      getSnapshots: () => this.snapshots,
      getSelectedId: () => this.selected?.id,
      onSelect: (id) => void this.selectSnapshot(id),
    };
  }

  private onClick(e: MouseEvent): void {
    const actBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!actBtn) return;
    switch (actBtn.dataset.act) {
      case "more": togglePvMoreMenu(actBtn as HTMLButtonElement, this.pvMoreMenuDeps()); return;
      case "history": togglePvHistory(actBtn, this.pvHistoryDeps()); return;
      default: return;
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderShell(): void {
    this.root.innerHTML = `
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
}

/** The rail's Preview tab, mounted by rail-panel.ts into its own tab body. */
export function mountPreviewTab(root: HTMLElement, deps: RailTabDeps): RailTabHandle {
  return new PreviewTab(root, deps);
}

/** Rail with the Preview tab wired in; `mode: "window"` is the todo 290
 *  pop-out, mounted via `mountPreviewWindow` below. */
export function renderPreview(root: HTMLElement, opts: { mode: RailMode }): PreviewController {
  return mountRail(root, { mode: opts.mode, mountPreview: mountPreviewTab });
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
