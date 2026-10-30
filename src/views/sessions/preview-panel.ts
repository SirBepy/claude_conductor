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
import { canPublish, publishIcon, publishLabel, publishTitle, publishToClaudeAi } from "../../shared/claude-ai-publish";
import { PREVIEW_SOURCE_CHAT_CARD } from "../../shared/chat/chat-preview-card";
import { togglePvMoreMenu, closePvMoreMenu, type DeviceWidth, type PvMoreMenuDeps } from "./preview-panel-more-menu";
import { togglePvHistory, closePvHistory, type PvHistoryDeps } from "./preview-panel-history";
import { mountPvComposer, type PvComposerDeps, type PvComposerHandle } from "./preview-panel-composer";
import { mountPreviewWindowShell, type RailController, type RailTabDeps, type RailTabHandle } from "./rail-panel";
import { isMirrored } from "./sessions-helpers";
import { state } from "./state";
import { mountPreviewStage } from "./preview-canvas";
import { applyPreviewTemplate } from "./preview-panel-document";
import "../../shared/chat/caret-popup/popup.css";
import "../../shared/chat/composer.css";
import { composerFieldHtml } from "../../shared/chat/composer-field";

/** What callers drive Preview through, in a pane window or the pop-out. */
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
      all = await invoke<PreviewMeta[]>("list_previews", { sessionId: this.currentSessionId });
    } catch (err) {
      console.error("[preview-panel] checkForUnseen failed", err);
      return;
    }
    const scoped = (Array.isArray(all) ? all : []).filter((m) => m.session_id === this.currentSessionId);
    const unseen = scoped.filter((m) => !this.seenIds.has(m.id));
    scoped.forEach((m) => this.seenIds.add(m.id));
    // Same carve-out as onLivePush: a show_preview push is already on screen
    // as a card, so it must not force the rail open on the next focus either.
    const mostRecentUnseen = unseen.filter((m) => m.source !== PREVIEW_SOURCE_CHAT_CARD).pop();
    if (opts.allowOpen && mostRecentUnseen && !this.deps.isOpen()) {
      this.deps.requestOpen(mostRecentUnseen.id);
    }
  }

  private async refreshList(opts: { selectId?: string } = {}): Promise<void> {
    try {
      // The session id routes the read: a chat mirrored from a paired machine
      // keeps its previews on that machine, and the daemon forwards there.
      const list = await invoke<PreviewMeta[]>("list_previews", { sessionId: this.currentSessionId });
      const all = Array.isArray(list) ? list : [];
      this.snapshots = all.filter((m) => m.session_id === this.currentSessionId);
      this.snapshots.forEach((s) => this.seenIds.add(s.id));
      // The list now covers only this chat, so only this chat's cached
      // snapshots can be judged gone; another chat's stay until it is revisited.
      const validIds = new Set(all.map((m) => m.id));
      for (const [id, cached] of this.snapshotCache) {
        if (cached.session_id === this.currentSessionId && !validIds.has(id)) this.snapshotCache.delete(id);
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
        this.selected = await invoke<PreviewSnapshot>("get_preview", { id, sessionId: this.currentSessionId });
      } catch (err) {
        console.error("[preview-panel] get_preview failed", err);
        return;
      }
      this.snapshotCache.set(id, this.selected);
    }
    this.renderHeader();
    void this.renderIframe();
  }

  /** `preview` notifier broadcast handler. Opens the panel for the active
   * chat's push (Joe, 2026-07-20: no opt-out on auto-refresh), EXCEPT a
   * `show_preview` push, which already rendered as a card in the transcript.
   * A background chat's push never switches the view (Joe, 2026-08-03). */
  private onLivePush(meta: PreviewMeta | undefined): void {
    if (!meta) return;
    if (meta.session_id !== this.currentSessionId) {
      if (meta.session_id && meta.source !== PREVIEW_SOURCE_CHAT_CARD) this.deps.markOpenFor(meta.session_id);
      return;
    }
    this.seenIds.add(meta.id);

    const idx = this.snapshots.findIndex((s) => s.id === meta.id);
    if (idx >= 0) this.snapshots[idx] = meta;
    else this.snapshots.unshift(meta);

    // A publish re-broadcasts the same id + version with only `published`
    // changed, which selectSnapshot skips as already on screen.
    if (this.selected?.id === meta.id && this.selected.version === meta.version) {
      this.selected.published = meta.published;
      return;
    }

    if (!this.deps.isOpen()) {
      if (meta.source !== PREVIEW_SOURCE_CHAT_CARD) this.deps.requestOpen(meta.id);
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
        const path = await invoke<string>("write_temp_html", { html: applyPreviewTemplate(this.selected!.html) });
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
      // Publish reads the LOCAL preview store, which never holds a mirrored
      // chat's snapshots (they live on the machine hosting the chat).
      publish: this.selected && canPublish() && !this.chatIsMirrored()
        ? {
            label: publishLabel(this.selected.published, this.selected.version),
            icon: publishIcon(this.selected.published, this.selected.version),
            title: publishTitle(this.selected.published, this.selected.version),
            onClick: () => this.publish(),
          }
        : undefined,
    };
  }

  private pvHistoryDeps(): PvHistoryDeps {
    return {
      getSnapshots: () => this.snapshots,
      getSelectedId: () => this.selected?.id,
      onSelect: (id) => void this.selectSnapshot(id),
    };
  }

  private chatIsMirrored(): boolean {
    return isMirrored(state.sessions.find((s) => s.session_id === this.currentSessionId));
  }

  private publish(): void {
    const snap = this.selected;
    if (!snap) return;
    void publishToClaudeAi(snap.id, snap.published, snap.version).then((link) => {
      if (!link || this.selected?.id !== snap.id) return;
      this.selected.published = link;
    });
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
      ${composerFieldHtml({
        rowClass: "composer-field--docked pv-composer",
        inputClass: "pv-composer-input",
        sendClass: "pv-composer-send",
        placeholder: "Message the session that pushed this preview...",
      })}
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

  // No re-entry guard like chat-preview-card.ts's mountPreviewFrame: this
  // rebuilds .pv-canvas fresh on every snapshot selection, so its iframe
  // is never stale.
  private async renderIframe(): Promise<void> {
    if (!this.selected) return;
    const canvas = this.root.querySelector<HTMLElement>(".pv-canvas");
    if (!canvas) return;
    const stage = mountPreviewStage(canvas, this.deviceWidth, this.selected.html);
    if (!stage) return;
    await stage.ready;
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

/** Preview's body, mounted into a pane window (pane-windows/panels.ts) or the
 *  pop-out window's shell. */
export function mountPreviewTab(root: HTMLElement, deps: RailTabDeps): RailTabHandle {
  return new PreviewTab(root, deps);
}

/** Pop-out window bootstrap (todo 290), called from main.ts's boot branch.
 *  Repopulates state.sessions (separate JS module realm) so the reply
 *  composer can resolve the session to send to. */
export async function mountPreviewWindow(root: HTMLElement, sessionId: string): Promise<PreviewController> {
  const { refreshSessions } = await import("./sidebar");
  await refreshSessions();
  const controller = mountPreviewWindowShell(root, mountPreviewTab);
  controller.setSessionScope(sessionId);
  controller.open();
  // The chat window re-invokes `open_preview_window` to focus this window
  // rather than re-sending a snapshot straight to it (separate realm, no
  // other channel) - see `open_preview_window`'s doc for why this is needed
  // even while already open.
  const { listen } = await import("../../shared/events");
  void listen<{ sessionId?: string; snapshotId?: string }>("preview-window-set-session", (p) => {
    if (!p?.sessionId) return;
    controller.setSessionScope(p.sessionId);
    controller.open(p.snapshotId);
  });
  return controller;
}
